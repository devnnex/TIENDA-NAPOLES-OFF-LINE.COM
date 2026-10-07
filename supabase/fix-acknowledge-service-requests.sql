-- Correccion exclusiva del error 0A000 en acknowledge_service_requests.
-- Ejecutar en el SQL Editor del proyecto Supabase. No modifica tablas,
-- permisos, usuarios, consumos ni ventas. Conserva firma y autenticacion.
create or replace function public.acknowledge_service_requests(
  auth_token text,
  ids uuid[],
  acknowledged_at timestamptz default now(),
  message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  staff_user public.app_users;
  result jsonb;
begin
  staff_user := public.require_app_user(auth_token);
  if coalesce(array_length(ids, 1), 0) = 0 or array_length(ids, 1) > 50 then
    raise exception 'Solicitudes invalidas.';
  end if;
  with changed as (
    update public.service_requests set
      status = 'acknowledged',
      acknowledged_by_user_id = staff_user.id,
      acknowledged_at = acknowledge_service_requests.acknowledged_at,
      message = case when acknowledge_service_requests.message is null then service_requests.message
        else left(acknowledge_service_requests.message, 1000) end
    where id = any(ids)
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(changed)), '[]'::jsonb) into result from changed;
  return result;
end;
$$;
