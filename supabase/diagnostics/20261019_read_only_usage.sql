-- Diagnóstico opcional. No se ejecuta desde la aplicación ni con las migraciones.
-- Solo lecturas agregadas; no muestra texto SQL, tokens ni datos de clientes.
begin read only;

select current_database() as database_name,
       pg_size_pretty(pg_database_size(current_database())) as database_size;

select schemaname, relname, n_live_tup, n_dead_tup, seq_scan, idx_scan,
       pg_size_pretty(pg_total_relation_size(relid)) as total_size
from pg_stat_user_tables
order by pg_total_relation_size(relid) desc
limit 30;

select datname, state, count(*) as connections
from pg_stat_activity
where datname = current_database()
group by datname, state
order by connections desc;

select n.nspname as extension_schema, e.extname, e.extversion
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'pg_stat_statements';

-- No mide GB de egress ni bytes de logs. Esos datos se consultan en el panel
-- de uso y en los logs por proyecto/servicio/ruta/estado, para el mismo período.
-- No habilitar extensiones ni resetear estadísticas para usar este archivo.
rollback;
