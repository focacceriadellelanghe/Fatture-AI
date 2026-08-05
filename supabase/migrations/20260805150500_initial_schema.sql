-- Fatture AI
-- Initial PostgreSQL schema for the migration from Google Sheets / Apps Script.
-- Source of truth: Supabase. Google Drive remains the document archive.
-- Google Sheets becomes a synchronized food-cost/reporting interface.

begin;

create extension if not exists pgcrypto;
create extension if not exists citext with schema extensions;

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------

create type public.app_role as enum ('viewer', 'operator', 'manager', 'owner');
create type public.invoice_status as enum (
  'RICEVUTA',
  'ANALISI_IN_CORSO',
  'DA_REVISIONARE',
  'COMPLETATA',
  'ERRORE_OCR',
  'DUPLICATA',
  'ARCHIVIATA'
);
create type public.invoice_row_status as enum (
  'DA_ASSOCIARE',
  'SUGGERITO',
  'CONFERMATO',
  'ESCLUSO'
);
create type public.record_status as enum ('ATTIVO', 'NON_ATTIVO', 'DISATTIVATO');
create type public.notification_status as enum ('DA_LEGGERE', 'LETTA', 'ARCHIVIATA');
create type public.sync_status as enum ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

create or replace function public.normalize_key(value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(upper(coalesce(value, '')), '[^A-Z0-9]+', '', 'g');
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Authentication, whitelist and roles
-- -----------------------------------------------------------------------------

create table public.allowed_users (
  email extensions.citext primary key,
  role public.app_role not null default 'viewer',
  active boolean not null default true,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email extensions.citext not null unique,
  display_name text,
  role public.app_role not null default 'viewer',
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger allowed_users_set_updated_at
before update on public.allowed_users
for each row execute function public.set_updated_at();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create or replace function public.role_rank(value public.app_role)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case value
    when 'viewer' then 10
    when 'operator' then 20
    when 'manager' then 30
    when 'owner' then 40
  end;
$$;

create or replace function public.current_user_is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active = true
  );
$$;

create or replace function public.has_min_role(required_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active = true
      and public.role_rank(p.role) >= public.role_rank(required_role)
  );
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed_role public.app_role;
  allowed_active boolean;
begin
  select a.role, a.active
    into allowed_role, allowed_active
  from public.allowed_users a
  where lower(a.email::text) = lower(coalesce(new.email, ''));

  insert into public.profiles (id, email, display_name, role, active)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(allowed_role, 'viewer'::public.app_role),
    coalesce(allowed_active, false)
  )
  on conflict (id) do update
    set email = excluded.email,
        display_name = coalesce(excluded.display_name, public.profiles.display_name),
        role = excluded.role,
        active = excluded.active,
        updated_at = now();

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert or update of email on auth.users
  for each row execute function public.handle_new_auth_user();

insert into public.allowed_users (email, role, active, note)
values ('simone.bordiga@gmail.com', 'owner', true, 'Proprietario iniziale Fatture AI')
on conflict (email) do update
set role = excluded.role,
    active = excluded.active,
    note = excluded.note,
    updated_at = now();

-- -----------------------------------------------------------------------------
-- Master data
-- -----------------------------------------------------------------------------

create table public.tracking_units (
  code text primary key,
  label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tracking_units_code_not_blank check (btrim(code) <> '')
);

create table public.suppliers (
  id text primary key,
  legal_name text not null,
  normalized_name text generated always as (public.normalize_key(legal_name)) stored,
  vat_number text,
  status public.record_status not null default 'ATTIVO',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint suppliers_name_not_blank check (btrim(legal_name) <> '')
);

create table public.supplier_aliases (
  id uuid primary key default gen_random_uuid(),
  supplier_id text not null references public.suppliers(id) on delete cascade,
  alias text not null,
  normalized_alias text generated always as (public.normalize_key(alias)) stored,
  status public.record_status not null default 'ATTIVO',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_alias_not_blank check (btrim(alias) <> '')
);

create table public.ingredients (
  id text primary key,
  name text not null,
  normalized_name text generated always as (public.normalize_key(name)) stored,
  category text not null,
  subcategory text not null,
  tracking_unit text not null references public.tracking_units(code),
  status public.record_status not null default 'ATTIVO',
  current_price numeric(14,6),
  previous_price numeric(14,6),
  price_change_percent numeric(14,6),
  latest_supplier_id text references public.suppliers(id) on delete set null,
  latest_invoice_id text,
  latest_purchase_date date,
  sheet_row integer,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingredients_name_not_blank check (btrim(name) <> ''),
  constraint ingredients_current_price_nonnegative check (current_price is null or current_price >= 0),
  constraint ingredients_previous_price_nonnegative check (previous_price is null or previous_price >= 0)
);

create trigger tracking_units_set_updated_at
before update on public.tracking_units
for each row execute function public.set_updated_at();

create trigger suppliers_set_updated_at
before update on public.suppliers
for each row execute function public.set_updated_at();

create trigger supplier_aliases_set_updated_at
before update on public.supplier_aliases
for each row execute function public.set_updated_at();

create trigger ingredients_set_updated_at
before update on public.ingredients
for each row execute function public.set_updated_at();

insert into public.tracking_units (code, label)
values
  ('€/kg', 'Euro per chilogrammo'),
  ('€/l', 'Euro per litro'),
  ('€/pz', 'Euro per pezzo'),
  ('€/confezione', 'Euro per confezione')
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- Invoices and OCR review
-- -----------------------------------------------------------------------------

create table public.invoices (
  id text primary key,
  document_date date,
  supplier_id text references public.suppliers(id) on delete set null,
  supplier_name_raw text,
  invoice_number text,
  invoice_number_normalized text generated always as (public.normalize_key(invoice_number)) stored,
  gross_total numeric(14,2),
  status public.invoice_status not null default 'RICEVUTA',
  drive_url text,
  archive_year integer,
  digital_status text,
  paper_available boolean,
  file_name text,
  drive_file_id text,
  uploaded_at timestamptz not null default now(),
  client_timestamp timestamptz,
  notes text,
  page_count integer not null default 1,
  source_files text[] not null default '{}'::text[],
  duplicate_of text references public.invoices(id) on delete set null,
  ocr_model text,
  ocr_started_at timestamptz,
  ocr_completed_at timestamptz,
  finalized_at timestamptz,
  version integer not null default 1,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoices_total_nonnegative check (gross_total is null or gross_total >= 0),
  constraint invoices_page_count_valid check (page_count between 1 and 10)
);

alter table public.ingredients
  add constraint ingredients_latest_invoice_fk
  foreign key (latest_invoice_id) references public.invoices(id) on delete set null;

create table public.invoice_rows (
  id text primary key,
  invoice_id text not null references public.invoices(id) on delete cascade,
  line_number integer not null,
  description text not null,
  item_code text,
  normalized_description text generated always as (public.normalize_key(description)) stored,
  normalized_item_code text generated always as (public.normalize_key(item_code)) stored,
  document_quantity numeric(14,6),
  document_unit text,
  package_count numeric(14,6),
  package_content numeric(14,6),
  package_content_unit text,
  tracking_quantity numeric(14,6),
  tracking_unit text references public.tracking_units(code),
  document_unit_price numeric(14,6),
  discount_percent numeric(10,6),
  line_net_amount numeric(14,6),
  vat_rate numeric(10,6),
  ingredient_id text references public.ingredients(id) on delete set null,
  status public.invoice_row_status not null default 'DA_ASSOCIARE',
  confidence smallint not null default 0,
  matching_method text,
  review_notes text,
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoice_rows_line_number_positive check (line_number > 0),
  constraint invoice_rows_description_not_blank check (btrim(description) <> ''),
  constraint invoice_rows_confidence_range check (confidence between 0 and 100),
  constraint invoice_rows_document_quantity_nonnegative check (document_quantity is null or document_quantity >= 0),
  constraint invoice_rows_tracking_quantity_nonnegative check (tracking_quantity is null or tracking_quantity >= 0),
  constraint invoice_rows_net_nonnegative check (line_net_amount is null or line_net_amount >= 0)
);

create table public.product_aliases (
  id text primary key,
  supplier_id text not null references public.suppliers(id) on delete cascade,
  description_original text not null,
  normalized_description text not null,
  item_code text,
  normalized_item_code text generated always as (public.normalize_key(item_code)) stored,
  ingredient_id text not null references public.ingredients(id) on delete restrict,
  matching_method text not null default 'CONFERMA_MANUALE',
  confidence smallint not null default 100,
  status public.record_status not null default 'ATTIVO',
  source_unit text,
  conversion_factor numeric(14,6),
  target_unit text references public.tracking_units(code),
  source_invoice_row_id text references public.invoice_rows(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_alias_description_not_blank check (btrim(description_original) <> ''),
  constraint product_alias_confidence_range check (confidence between 0 and 100),
  constraint product_alias_conversion_positive check (conversion_factor is null or conversion_factor > 0)
);

create trigger invoices_set_updated_at
before update on public.invoices
for each row execute function public.set_updated_at();

create trigger invoice_rows_set_updated_at
before update on public.invoice_rows
for each row execute function public.set_updated_at();

create trigger product_aliases_set_updated_at
before update on public.product_aliases
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Price history and dashboard state
-- -----------------------------------------------------------------------------

create table public.price_history (
  id text primary key,
  ingredient_id text not null references public.ingredients(id) on delete restrict,
  document_date date not null,
  supplier_id text references public.suppliers(id) on delete set null,
  invoice_id text not null references public.invoices(id) on delete restrict,
  invoice_row_id text references public.invoice_rows(id) on delete set null,
  description text not null,
  quantity numeric(14,6) not null,
  tracking_unit text not null references public.tracking_units(code),
  normalized_price numeric(14,6) not null,
  previous_price numeric(14,6),
  percentage_change numeric(14,6),
  taxable_amount numeric(14,6) not null,
  vat_rate numeric(10,6),
  recorded_at timestamptz not null default now(),
  status text not null default 'VALIDO',
  metadata jsonb not null default '{}'::jsonb,
  constraint price_history_quantity_positive check (quantity > 0),
  constraint price_history_price_nonnegative check (normalized_price >= 0),
  constraint price_history_taxable_nonnegative check (taxable_amount >= 0)
);

create table public.price_analysis (
  ingredient_id text primary key references public.ingredients(id) on delete cascade,
  tracking_unit text not null references public.tracking_units(code),
  current_price numeric(14,6),
  previous_price numeric(14,6),
  minimum_price numeric(14,6),
  maximum_price numeric(14,6),
  average_price numeric(14,6),
  percentage_change numeric(14,6),
  purchase_count integer not null default 0,
  latest_supplier_id text references public.suppliers(id) on delete set null,
  latest_invoice_id text references public.invoices(id) on delete set null,
  latest_purchase_date date,
  trend text,
  updated_at timestamptz not null default now(),
  constraint price_analysis_purchase_count_nonnegative check (purchase_count >= 0)
);

-- -----------------------------------------------------------------------------
-- Notifications, synchronization and audit
-- -----------------------------------------------------------------------------

create table public.notifications (
  id text primary key,
  type text not null,
  event_at timestamptz not null default now(),
  invoice_id text references public.invoices(id) on delete cascade,
  ingredient_id text references public.ingredients(id) on delete cascade,
  title text not null,
  detail text,
  previous_value numeric(14,6),
  new_value numeric(14,6),
  percentage_change numeric(14,6),
  percentage_point_change numeric(14,6),
  unit text,
  severity text,
  color text,
  status public.notification_status not null default 'DA_LEGGERE',
  destination_type text,
  destination_id text,
  destination_view text,
  read_by uuid references public.profiles(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.sheet_sync_queue (
  id bigint generated always as identity primary key,
  entity_type text not null,
  entity_id text not null,
  operation text not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  status public.sync_status not null default 'PENDING',
  attempts integer not null default 0,
  not_before timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint sheet_sync_attempts_nonnegative check (attempts >= 0)
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  old_data jsonb,
  new_data jsonb,
  request_id uuid,
  occurred_at timestamptz not null default now()
);

create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  status text not null default 'PENDING',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  rows_read integer not null default 0,
  rows_inserted integer not null default 0,
  rows_skipped integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  notes text
);

create trigger sheet_sync_queue_set_updated_at
before update on public.sheet_sync_queue
for each row execute function public.set_updated_at();

create unique index sheet_sync_queue_active_dedupe_idx
on public.sheet_sync_queue (dedupe_key)
where status in ('PENDING', 'PROCESSING');

create or replace function public.enqueue_sheet_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data jsonb;
  entity_identifier text;
  operation_name text;
  dedupe text;
begin
  if tg_op = 'DELETE' then
    row_data := to_jsonb(old);
    entity_identifier := coalesce(to_jsonb(old) ->> 'id', to_jsonb(old) ->> 'ingredient_id');
    operation_name := 'DELETE';
  else
    row_data := to_jsonb(new);
    entity_identifier := coalesce(to_jsonb(new) ->> 'id', to_jsonb(new) ->> 'ingredient_id');
    operation_name := tg_op;
  end if;

  dedupe := tg_table_name || ':' || coalesce(entity_identifier, 'unknown');

  insert into public.sheet_sync_queue (
    entity_type,
    entity_id,
    operation,
    payload,
    dedupe_key,
    status,
    not_before
  )
  values (
    tg_table_name,
    coalesce(entity_identifier, ''),
    operation_name,
    row_data,
    dedupe,
    'PENDING',
    now()
  )
  on conflict (dedupe_key) where status in ('PENDING', 'PROCESSING')
  do update set
    operation = excluded.operation,
    payload = excluded.payload,
    status = 'PENDING',
    attempts = 0,
    not_before = now(),
    locked_at = null,
    locked_by = null,
    last_error = null,
    processed_at = null,
    updated_at = now();

  return coalesce(new, old);
end;
$$;

create trigger invoices_enqueue_sheet_sync
after insert or update or delete on public.invoices
for each row execute function public.enqueue_sheet_sync();

create trigger ingredients_enqueue_sheet_sync
after insert or update or delete on public.ingredients
for each row execute function public.enqueue_sheet_sync();

create trigger price_history_enqueue_sheet_sync
after insert or update or delete on public.price_history
for each row execute function public.enqueue_sheet_sync();

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_json jsonb;
  new_json jsonb;
  identifier text;
begin
  old_json := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  new_json := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;
  identifier := coalesce(new_json ->> 'id', old_json ->> 'id', new_json ->> 'ingredient_id', old_json ->> 'ingredient_id');

  insert into public.audit_log (
    actor_id,
    action,
    entity_type,
    entity_id,
    old_data,
    new_data
  )
  values (
    auth.uid(),
    tg_op,
    tg_table_name,
    identifier,
    old_json,
    new_json
  );

  return coalesce(new, old);
end;
$$;

create trigger invoices_audit
after insert or update or delete on public.invoices
for each row execute function public.audit_row_change();

create trigger invoice_rows_audit
after insert or update or delete on public.invoice_rows
for each row execute function public.audit_row_change();

create trigger ingredients_audit
after insert or update or delete on public.ingredients
for each row execute function public.audit_row_change();

create trigger suppliers_audit
after insert or update or delete on public.suppliers
for each row execute function public.audit_row_change();

create trigger product_aliases_audit
after insert or update or delete on public.product_aliases
for each row execute function public.audit_row_change();

-- -----------------------------------------------------------------------------
-- Performance indexes
-- -----------------------------------------------------------------------------

create unique index suppliers_normalized_name_active_uidx
on public.suppliers (normalized_name)
where status = 'ATTIVO';

create index supplier_aliases_normalized_idx
on public.supplier_aliases (normalized_alias)
where status = 'ATTIVO';

create index ingredients_name_idx on public.ingredients (normalized_name);
create index ingredients_category_idx on public.ingredients (category, subcategory);
create index ingredients_status_idx on public.ingredients (status);

create index invoices_status_date_idx on public.invoices (status, document_date desc, uploaded_at desc);
create index invoices_supplier_date_idx on public.invoices (supplier_id, document_date desc);
create index invoices_uploaded_at_idx on public.invoices (uploaded_at desc);
create index invoices_drive_file_idx on public.invoices (drive_file_id);

create unique index invoices_business_key_uidx
on public.invoices (supplier_id, invoice_number_normalized, document_date)
where supplier_id is not null
  and invoice_number_normalized <> ''
  and document_date is not null
  and status <> 'DUPLICATA';

create index invoice_rows_invoice_idx on public.invoice_rows (invoice_id, line_number);
create index invoice_rows_status_idx on public.invoice_rows (status);
create index invoice_rows_ingredient_idx on public.invoice_rows (ingredient_id);
create index invoice_rows_item_code_idx on public.invoice_rows (normalized_item_code);

create index product_aliases_supplier_code_idx
on public.product_aliases (supplier_id, normalized_item_code)
where status = 'ATTIVO';

create index product_aliases_supplier_description_idx
on public.product_aliases (supplier_id, normalized_description)
where status = 'ATTIVO';

create unique index price_history_invoice_row_uidx
on public.price_history (invoice_row_id)
where invoice_row_id is not null;

create index price_history_ingredient_date_idx
on public.price_history (ingredient_id, document_date desc, recorded_at desc);

create index price_history_supplier_date_idx
on public.price_history (supplier_id, document_date desc);

create index notifications_status_event_idx
on public.notifications (status, event_at desc);

create index notifications_ingredient_idx
on public.notifications (ingredient_id, event_at desc);

create index sheet_sync_queue_work_idx
on public.sheet_sync_queue (status, not_before, created_at);

create index audit_log_entity_idx
on public.audit_log (entity_type, entity_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- Read-optimized views used by the web app
-- -----------------------------------------------------------------------------

create view public.invoice_list_view
with (security_invoker = true)
as
select
  i.id,
  i.document_date,
  i.supplier_id,
  coalesce(s.legal_name, i.supplier_name_raw) as supplier,
  i.invoice_number,
  i.gross_total,
  i.status,
  i.drive_url,
  i.file_name,
  i.uploaded_at,
  i.notes,
  i.page_count,
  i.duplicate_of,
  count(r.id) as row_count,
  count(r.id) filter (where r.status = 'CONFERMATO') as confirmed_count,
  count(r.id) filter (where r.status = 'ESCLUSO') as excluded_count,
  count(r.id) filter (where r.status in ('DA_ASSOCIARE', 'SUGGERITO')) as pending_count
from public.invoices i
left join public.suppliers s on s.id = i.supplier_id
left join public.invoice_rows r on r.invoice_id = i.id
group by i.id, s.legal_name;

create view public.price_dashboard_view
with (security_invoker = true)
as
select
  ing.id as ingredient_id,
  ing.name,
  ing.category,
  ing.subcategory,
  ing.tracking_unit,
  ing.status,
  pa.current_price,
  pa.previous_price,
  pa.minimum_price,
  pa.maximum_price,
  pa.average_price,
  pa.percentage_change,
  pa.purchase_count,
  pa.latest_supplier_id,
  s.legal_name as latest_supplier,
  pa.latest_invoice_id,
  pa.latest_purchase_date,
  pa.trend,
  pa.updated_at
from public.ingredients ing
left join public.price_analysis pa on pa.ingredient_id = ing.id
left join public.suppliers s on s.id = pa.latest_supplier_id;

create view public.app_status_view
with (security_invoker = true)
as
select
  count(*) filter (where status = 'RICEVUTA') as received,
  count(*) filter (where status = 'ANALISI_IN_CORSO') as analyzing,
  count(*) filter (where status = 'DA_REVISIONARE') as ready,
  count(*) filter (where status = 'COMPLETATA') as completed,
  count(*) filter (where status = 'ERRORE_OCR') as errors,
  count(*) filter (where status = 'DUPLICATA') as duplicates
from public.invoices;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table public.allowed_users enable row level security;
alter table public.profiles enable row level security;
alter table public.tracking_units enable row level security;
alter table public.suppliers enable row level security;
alter table public.supplier_aliases enable row level security;
alter table public.ingredients enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_rows enable row level security;
alter table public.product_aliases enable row level security;
alter table public.price_history enable row level security;
alter table public.price_analysis enable row level security;
alter table public.notifications enable row level security;
alter table public.sheet_sync_queue enable row level security;
alter table public.audit_log enable row level security;
alter table public.import_runs enable row level security;

create policy allowed_users_owner_all
on public.allowed_users
for all
to authenticated
using (public.has_min_role('owner'))
with check (public.has_min_role('owner'));

create policy profiles_select_self_or_owner
on public.profiles
for select
to authenticated
using (id = auth.uid() or public.has_min_role('owner'));

create policy profiles_owner_update
on public.profiles
for update
to authenticated
using (public.has_min_role('owner'))
with check (public.has_min_role('owner'));

create policy reference_data_select_active_users
on public.tracking_units
for select
to authenticated
using (public.current_user_is_active());

create policy tracking_units_manager_write
on public.tracking_units
for all
to authenticated
using (public.has_min_role('manager'))
with check (public.has_min_role('manager'));

create policy suppliers_select_active_users
on public.suppliers
for select
to authenticated
using (public.current_user_is_active());

create policy suppliers_manager_write
on public.suppliers
for all
to authenticated
using (public.has_min_role('manager'))
with check (public.has_min_role('manager'));

create policy supplier_aliases_select_active_users
on public.supplier_aliases
for select
to authenticated
using (public.current_user_is_active());

create policy supplier_aliases_manager_write
on public.supplier_aliases
for all
to authenticated
using (public.has_min_role('manager'))
with check (public.has_min_role('manager'));

create policy ingredients_select_active_users
on public.ingredients
for select
to authenticated
using (public.current_user_is_active());

create policy ingredients_manager_write
on public.ingredients
for all
to authenticated
using (public.has_min_role('manager'))
with check (public.has_min_role('manager'));

create policy invoices_select_active_users
on public.invoices
for select
to authenticated
using (public.current_user_is_active());

create policy invoices_operator_insert
on public.invoices
for insert
to authenticated
with check (public.has_min_role('operator'));

create policy invoices_operator_update
on public.invoices
for update
to authenticated
using (public.has_min_role('operator'))
with check (public.has_min_role('operator'));

create policy invoices_manager_delete
on public.invoices
for delete
to authenticated
using (public.has_min_role('manager'));

create policy invoice_rows_select_active_users
on public.invoice_rows
for select
to authenticated
using (public.current_user_is_active());

create policy invoice_rows_operator_insert
on public.invoice_rows
for insert
to authenticated
with check (public.has_min_role('operator'));

create policy invoice_rows_operator_update
on public.invoice_rows
for update
to authenticated
using (public.has_min_role('operator'))
with check (public.has_min_role('operator'));

create policy invoice_rows_manager_delete
on public.invoice_rows
for delete
to authenticated
using (public.has_min_role('manager'));

create policy product_aliases_select_active_users
on public.product_aliases
for select
to authenticated
using (public.current_user_is_active());

create policy product_aliases_manager_write
on public.product_aliases
for all
to authenticated
using (public.has_min_role('manager'))
with check (public.has_min_role('manager'));

create policy price_history_select_active_users
on public.price_history
for select
to authenticated
using (public.current_user_is_active());

create policy price_history_manager_write
on public.price_history
for all
to authenticated
using (public.has_min_role('manager'))
with check (public.has_min_role('manager'));

create policy price_analysis_select_active_users
on public.price_analysis
for select
to authenticated
using (public.current_user_is_active());

create policy price_analysis_manager_write
on public.price_analysis
for all
to authenticated
using (public.has_min_role('manager'))
with check (public.has_min_role('manager'));

create policy notifications_select_active_users
on public.notifications
for select
to authenticated
using (public.current_user_is_active());

create policy notifications_active_users_update
on public.notifications
for update
to authenticated
using (public.current_user_is_active())
with check (public.current_user_is_active());

create policy notifications_manager_insert_delete
on public.notifications
for all
to authenticated
using (public.has_min_role('manager'))
with check (public.has_min_role('manager'));

create policy sheet_sync_queue_owner_all
on public.sheet_sync_queue
for all
to authenticated
using (public.has_min_role('owner'))
with check (public.has_min_role('owner'));

create policy audit_log_owner_select
on public.audit_log
for select
to authenticated
using (public.has_min_role('owner'));

create policy import_runs_owner_all
on public.import_runs
for all
to authenticated
using (public.has_min_role('owner'))
with check (public.has_min_role('owner'));

-- No anonymous access. Authenticated grants are still constrained by RLS.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

commit;
