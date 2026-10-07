-- Parche exclusivo de UPDATE sin WHERE en la definicion EXISTENTE de
-- save_table_zones. Conserva parametros, autenticacion, permisos y retorno.
-- No desactiva safeupdate ni ejecuta cambios de datos.
do $patch$
declare
  function_oid oid;
  definition text;
  statement text;
  replacement text;
  patched_count integer := 0;
begin
  select p.oid into strict function_oid
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'save_table_zones'
    and p.proargnames @> array['auth_token', 'outdoor_table_ids']::text[];
  definition := pg_get_functiondef(function_oid);
  for statement in
    select m[1] from regexp_matches(definition,
      '(update\s+(?:public\.|"public"\.)?(?:restaurant_tables|"restaurant_tables")\s+set\s+[^;]+;)', 'gi') as m
  loop
    if statement ~* '\mwhere\M' then continue; end if;
    if statement ~* '\mreturning\M' then
      replacement := regexp_replace(statement, '\mreturning\M', 'where id is not null returning', 'i');
    else
      replacement := regexp_replace(statement, ';$', ' where id is not null;');
    end if;
    definition := replace(definition, statement, replacement);
    patched_count := patched_count + 1;
  end loop;
  if patched_count = 0 then
    raise notice 'No se encontro UPDATE sin WHERE compatible. La funcion no se modifico; revisar su definicion si el error persiste.';
    return;
  end if;
  execute definition;
  raise notice 'save_table_zones: % UPDATE corregido(s).', patched_count;
end;
$patch$;
