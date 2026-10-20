-- Publica un conjunto completo de avisos confirmados en una transacción.
-- Conserva la bitácora, los IDs y los permisos de lectura existentes.
begin;

create or replace function public.publish_report_changes_batch(auth_token text, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  staff jsonb;
  change jsonb;
  saved public.pos_report_changes;
  receipts jsonb := '[]'::jsonb;
  inserted boolean := false;
  duplicate boolean;
begin
  staff := to_jsonb(public.require_app_user(auth_token));
  if staff->>'role' not in ('boss','admin') then raise exception 'No autorizado'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then raise exception 'Lote no válido'; end if;
  if jsonb_array_length(p_changes) not between 1 and 20 or octet_length(p_changes::text)>5000000 then
    raise exception 'Lote no válido';
  end if;
  perform pg_advisory_xact_lock(1313102026);
  for change in select value from jsonb_array_elements(p_changes) loop
    if coalesce(change->>'action','') not in ('record_sale','edit_sale','delete_sale','clear_income','adjust_inventory','upsert_inventory','set_inventory_stock','delete_inventory','clear_inventory','update_inventory_movement_cost','clear_inventory_movements')
      or coalesce(length(change->>'operationId'),0) not between 1 and 200
      or coalesce(jsonb_typeof(change->'payload'),'null') <> 'object'
      or octet_length((change->'payload')::text)>2000000 then
      raise exception 'Cambio no válido';
    end if;
    select * into saved from public.pos_report_changes c where c.operation_id=change->>'operationId';
    duplicate := found;
    if duplicate then
      if saved.action<>change->>'action' then raise exception 'Operación ya utilizada'; end if;
    else
      insert into public.pos_report_changes(operation_id,action,payload)
        values(change->>'operationId',change->>'action',change->'payload') returning * into saved;
      inserted := true;
    end if;
    receipts := receipts || jsonb_build_array(jsonb_build_object('operationId',saved.operation_id,'sequence',saved.sequence,'duplicate',duplicate));
  end loop;
  if inserted then perform realtime.send('{}'::jsonb,'reports-committed','admin',false); end if;
  return jsonb_build_object('ok',true,'results',receipts);
end;
$$;

revoke all on function public.publish_report_changes_batch(text,jsonb) from public;
grant execute on function public.publish_report_changes_batch(text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
commit;
