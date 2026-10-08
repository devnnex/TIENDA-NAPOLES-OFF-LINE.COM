-- Ejecutar UNA vez en el backend compartido, después de la migración de abonos.
-- Idempotente. Conserva los abonos archivados de cuentas cerradas.
begin;

-- Usa el mismo bloqueo de cuenta que record_session_payment. Un abono y una
-- modificación de consumo nunca validan el saldo simultáneamente.
create or replace function public.lock_session_consumption_account()
returns trigger language plpgsql security definer set search_path = public as $$
declare account_ids uuid[];
begin
  if tg_op = 'INSERT' then account_ids := array[new.session_id];
  elsif tg_op = 'DELETE' then account_ids := array[old.session_id];
  else account_ids := array[old.session_id,new.session_id];
  end if;
  perform 1 from public.table_sessions s where s.id = any(account_ids) order by s.id for update;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

-- Valida al terminar la sentencia para permitir retirar TODOS los productos
-- juntos, sin rechazar estados intermedios de una eliminación de varias filas.
create or replace function public.validate_session_consumption_payments()
returns trigger language plpgsql security definer set search_path = public as $$
declare account_ids uuid[]; account_id uuid; consumed numeric; paid numeric;
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct session_id) into account_ids from new_consumption_rows;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct session_id) into account_ids from old_consumption_rows;
  else
    select array_agg(distinct session_id) into account_ids from (
      select session_id from new_consumption_rows union select session_id from old_consumption_rows
    ) changed;
  end if;
  for account_id in select s.id from public.table_sessions s
    where s.id = any(account_ids) and s.status = 'open' order by s.id for update
  loop
    select coalesce(sum(i.quantity*round(i.unit_price)),0) into consumed
      from public.session_items i where i.session_id=account_id and i.status <> 'cancelled';
    select coalesce(sum(p.amount),0) into paid from public.session_payments p where p.session_id=account_id;
    if consumed > 0 and consumed < paid then
      raise exception 'No se puede reducir el consumo por debajo de los abonos. Conserva productos por el valor abonado o retira todo el consumo.';
    end if;
    if consumed = 0 and paid > 0 then
      delete from public.session_payments p where p.session_id=account_id;
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists session_consumption_account_lock on public.session_items;
create trigger session_consumption_account_lock before insert or update or delete
  on public.session_items for each row execute function public.lock_session_consumption_account();
drop trigger if exists session_consumption_payments_insert on public.session_items;
create trigger session_consumption_payments_insert after insert on public.session_items
  referencing new table as new_consumption_rows for each statement execute function public.validate_session_consumption_payments();
drop trigger if exists session_consumption_payments_update on public.session_items;
create trigger session_consumption_payments_update after update on public.session_items
  referencing old table as old_consumption_rows new table as new_consumption_rows
  for each statement execute function public.validate_session_consumption_payments();
drop trigger if exists session_consumption_payments_delete on public.session_items;
create trigger session_consumption_payments_delete after delete on public.session_items
  referencing old table as old_consumption_rows for each statement execute function public.validate_session_consumption_payments();
revoke all on function public.lock_session_consumption_account(),public.validate_session_consumption_payments() from public,anon,authenticated;

-- Limpia únicamente cuentas abiertas que ya quedaron sin consumo antes de
-- instalar esta regla. No altera cuentas con consumo ni pagos archivados.
do $$
declare account_id uuid;
begin
  for account_id in select s.id from public.table_sessions s where s.status='open' order by s.id for update loop
    if not exists(select 1 from public.session_items i where i.session_id=account_id and i.status <> 'cancelled' and i.quantity*round(i.unit_price) > 0) then
      delete from public.session_payments p where p.session_id=account_id;
    end if;
  end loop;
end;
$$;
notify pgrst, 'reload schema';
commit;
