begin;

alter table public.business_settings
  add column if not exists client_bill_enabled boolean not null default true;

-- Realtime solo anuncia que hay cambios. Los importes se leen con el token del empleado.
create table if not exists public.pos_report_changes (
  sequence bigint generated always as identity primary key,
  operation_id text not null unique,
  action text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.pos_report_changes enable row level security;
revoke all on public.pos_report_changes from public, anon, authenticated;

create or replace function public.publish_report_change(auth_token text, p_operation_id text, p_action text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare staff jsonb; saved public.pos_report_changes;
begin
  staff := to_jsonb(public.require_app_user(auth_token));
  if staff->>'role' not in ('boss','admin') then raise exception 'No autorizado'; end if;
  if p_action not in ('record_sale','edit_sale','delete_sale','clear_income','adjust_inventory','upsert_inventory','set_inventory_stock','delete_inventory','clear_inventory','update_inventory_movement_cost','clear_inventory_movements')
     or coalesce(length(p_operation_id),0) not between 1 and 200
     or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 2000000 then
    raise exception 'Cambio no válido';
  end if;
  -- Orden de confirmación estable también cuando dos equipos escriben juntos.
  perform pg_advisory_xact_lock(1313102026);
  select * into saved from public.pos_report_changes c where c.operation_id=p_operation_id;
  if found then
    if saved.action <> p_action then raise exception 'Operación ya utilizada'; end if;
    return jsonb_build_object('ok',true,'sequence',saved.sequence,'duplicate',true);
  end if;
  insert into public.pos_report_changes(operation_id,action,payload)
    values(p_operation_id,p_action,p_payload) returning * into saved;
  perform realtime.send('{}'::jsonb,'reports-committed','admin',false);
  return jsonb_build_object('ok',true,'sequence',saved.sequence);
end;
$$;

create or replace function public.get_report_changes(auth_token text, p_after bigint default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare staff jsonb; sales_allowed boolean; stock_allowed boolean; changes jsonb;
begin
  staff := to_jsonb(public.require_app_user(auth_token));
  sales_allowed := staff->>'role'='boss' or (staff->>'role'='admin' and (staff->'permissions' is null or staff->'permissions'='null'::jsonb or staff->'permissions' ? 'income'));
  stock_allowed := staff->>'role'='boss' or (staff->>'role'='admin' and (staff->'permissions' is null or staff->'permissions'='null'::jsonb or staff->'permissions' ?| array['inventory','movements']));
  if not sales_allowed and not stock_allowed then raise exception 'No autorizado'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('sequence',c.sequence,'action',c.action,'confirmedAt',c.created_at,'payload',
    (case when sales_allowed then c.payload else c.payload-'invoice'-'saleId' end)
    || case when stock_allowed then '{}'::jsonb else jsonb_build_object('movements','[]'::jsonb,'items','[]'::jsonb) end
  ) order by c.sequence),'[]'::jsonb) into changes
  from (select * from public.pos_report_changes where sequence > greatest(p_after,0) order by sequence limit 200) c;
  return jsonb_build_object('ok',true,'changes',changes,'hasMore',jsonb_array_length(changes)=200);
end;
$$;

revoke all on function public.publish_report_change(text,text,text,jsonb) from public;
revoke all on function public.get_report_changes(text,bigint) from public;
grant execute on function public.publish_report_change(text,text,text,jsonb) to anon, authenticated;
grant execute on function public.get_report_changes(text,bigint) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
