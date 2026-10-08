-- Tras cinco canciones pendientes de una mesa, cierra su chat de cliente
-- hasta que el equipo atienda el turno. Comparte el bloqueo con el limite
-- de canciones para cubrir solicitudes simultaneas desde varios dispositivos.
create or replace function public.enforce_song_chat_turn_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.sender_type <> 'client' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('song:' || new.table_id::text, 0));
  if exists(select 1 from public.chat_messages m where m.id = new.id) then return new; end if;
  if (select count(*) from public.service_requests r
      where r.table_id = new.table_id and r.status = 'pending'
        and r.request_type = 'other' and lower(r.message) like '%solicita la canci%n:%') >= 5 then
    raise exception 'Ya solicitaste 5 canciones en este turno. Espera a que termine tu turno.';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_messages_song_turn_limit on public.chat_messages;
create trigger chat_messages_song_turn_limit before insert on public.chat_messages
for each row execute function public.enforce_song_chat_turn_limit();
