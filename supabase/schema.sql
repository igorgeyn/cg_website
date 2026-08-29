-- Nori's Nibbles order system
-- Run this file once in the Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.batches (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Next Fresh Batch',
  goal_units integer not null default 20 check (goal_units > 0),
  status text not null default 'collecting'
    check (status in ('collecting', 'goal_reached', 'growing', 'ready', 'delivery_planning', 'complete')),
  is_active boolean not null default true,
  opened_at timestamptz not null default now(),
  growing_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists one_active_batch
  on public.batches (is_active)
  where is_active = true;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  batch_id uuid not null references public.batches(id),
  full_name text not null,
  email text not null,
  phone text not null,
  address_line1 text not null,
  address_line2 text,
  city text not null,
  zip text not null,
  delivery_method text not null
    check (delivery_method in ('contactless', 'in_person')),
  payment_method text not null
    check (payment_method in ('venmo_now', 'pay_on_delivery')),
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'awaiting_confirmation', 'paid')),
  order_status text not null default 'received'
    check (order_status in ('received', 'confirmed', 'growing', 'ready', 'scheduled', 'delivered', 'cancelled', 'spam')),
  subtotal_cents integer not null check (subtotal_cents >= 0),
  delivery_fee_cents integer not null default 0 check (delivery_fee_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  tracker_units integer not null check (tracker_units > 0),
  delivery_notes text,
  marketing_opt_in boolean not null default false,
  request_fingerprint text,
  assigned_delivery_date date,
  assigned_delivery_window text,
  schedule_approved boolean not null default false,
  schedule_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders add column if not exists schedule_notified_at timestamptz;

create index if not exists orders_batch_id_idx on public.orders(batch_id);
create index if not exists orders_city_zip_idx on public.orders(city, zip);
create index if not exists orders_created_at_idx on public.orders(created_at desc);
create index if not exists orders_request_fingerprint_idx on public.orders(request_fingerprint, created_at desc);

create table if not exists public.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  sku text not null check (sku in ('small', 'large', 'xl')),
  product_name text not null,
  quantity integer not null check (quantity > 0 and quantity <= 20),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  tracker_units_each integer not null check (tracker_units_each > 0)
);

create index if not exists order_items_order_id_idx on public.order_items(order_id);

create table if not exists public.delivery_preferences (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  slot_code text not null,
  unique(order_id, slot_code)
);

create table if not exists public.batch_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  is_active boolean not null default true,
  unsubscribe_token uuid not null default gen_random_uuid() unique,
  created_at timestamptz not null default now()
);

alter table public.batch_subscribers add column if not exists unsubscribe_token uuid not null default gen_random_uuid();
create unique index if not exists batch_subscribers_unsubscribe_token_idx on public.batch_subscribers(unsubscribe_token);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
before update on public.orders
for each row execute function public.set_updated_at();

create or replace function public.is_noris_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'igorgeyn@gmail.com';
$$;

alter table public.batches enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.delivery_preferences enable row level security;
alter table public.batch_subscribers enable row level security;

drop policy if exists "Admin manages batches" on public.batches;
create policy "Admin manages batches" on public.batches
  for all to authenticated using (public.is_noris_admin()) with check (public.is_noris_admin());

drop policy if exists "Admin manages orders" on public.orders;
create policy "Admin manages orders" on public.orders
  for all to authenticated using (public.is_noris_admin()) with check (public.is_noris_admin());

drop policy if exists "Admin manages order items" on public.order_items;
create policy "Admin manages order items" on public.order_items
  for all to authenticated using (public.is_noris_admin()) with check (public.is_noris_admin());

drop policy if exists "Admin manages delivery preferences" on public.delivery_preferences;
create policy "Admin manages delivery preferences" on public.delivery_preferences
  for all to authenticated using (public.is_noris_admin()) with check (public.is_noris_admin());

drop policy if exists "Admin manages subscribers" on public.batch_subscribers;
create policy "Admin manages subscribers" on public.batch_subscribers
  for all to authenticated using (public.is_noris_admin()) with check (public.is_noris_admin());

revoke all on public.batches from anon;
revoke all on public.orders from anon;
revoke all on public.order_items from anon;
revoke all on public.delivery_preferences from anon;
revoke all on public.batch_subscribers from anon;

create or replace function public.start_new_batch()
returns public.batches
language plpgsql
security definer
set search_path = public
as $$
declare
  created_batch public.batches;
begin
  if not public.is_noris_admin() then
    raise exception 'Not authorized';
  end if;

  update public.batches
    set is_active = false,
        status = 'complete',
        completed_at = coalesce(completed_at, now())
    where is_active = true;

  insert into public.batches (name, goal_units, status, is_active)
    values ('Next Fresh Batch', 20, 'collecting', true)
    returning * into created_batch;

  return created_batch;
end;
$$;

revoke all on function public.start_new_batch() from public, anon;
grant execute on function public.start_new_batch() to authenticated;

insert into public.batches (name, goal_units, status, is_active)
select 'Next Fresh Batch', 20, 'collecting', true
where not exists (select 1 from public.batches where is_active = true);
