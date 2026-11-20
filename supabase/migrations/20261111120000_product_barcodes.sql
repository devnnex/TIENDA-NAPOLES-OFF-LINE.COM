-- Optional product barcode; preserves existing names, acronyms, prices and stock.
begin;
alter table public.menu_items add column if not exists barcode text;
create unique index if not exists menu_items_barcode_unique
  on public.menu_items (barcode) where barcode is not null;
notify pgrst, 'reload schema';
commit;
