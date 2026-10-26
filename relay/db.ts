import postgres from 'postgres'

export type Sql = postgres.Sql

// Tudo do relay mora no schema kora_sync, com um usuário de banco que só enxerga ele: o mesmo Postgres guarda outros
// projetos, e um relay comprometido não alcança as tabelas deles. O schema e o usuário são criados uma vez, à mão
// (relay/bootstrap.sql); daqui em diante o relay aplica sozinho as migrações abaixo, em ordem, uma vez cada.
export const SCHEMA = 'kora_sync'

const MIGRATIONS: string[] = [
  `
  -- A senha só é gravada junto com o código de verificação: quem cadastra o e-mail de outra pessoa não define a
  -- senha da conta que ela vai ativar.
  create table kora_sync.accounts (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    password_hash text,
    verified_at timestamptz,
    admin boolean not null default false,
    blocked_at timestamptz,
    blocked_reason text,
    created_at timestamptz not null default now(),
    last_login_at timestamptz
  );
  create unique index accounts_email on kora_sync.accounts (email);

  -- Código de verificação ou de troca de senha: só o HMAC fica guardado, um por conta e tipo.
  create table kora_sync.codes (
    account_id uuid not null references kora_sync.accounts on delete cascade,
    kind text not null check (kind in ('verify', 'reset')),
    code_hash text not null,
    expires_at timestamptz not null,
    attempts int not null default 0,
    created_at timestamptz not null default now(),
    primary key (account_id, kind)
  );

  -- PCs e celulares, pela impressão digital (SHA-256) do certificado. Cada conexão traz o certificado e a assinatura,
  -- então basta a impressão digital para saber de quem é. O celular fica na conta do PC que o registrou por último.
  create table kora_sync.devices (
    fingerprint text primary key,
    account_id uuid not null references kora_sync.accounts on delete cascade,
    kind text not null check (kind in ('pc', 'phone')),
    name text,
    platform text,
    os_version text,
    app_version text,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz,
    last_ip text,
    bytes_in bigint not null default 0,
    bytes_out bigint not null default 0,
    sessions bigint not null default 0,
    connected_seconds bigint not null default 0
  );
  create index devices_account on kora_sync.devices (account_id);

  -- Quais PCs cada celular pode procurar: o mesmo celular pareado com o PC de casa e o do trabalho fica nos dois.
  create table kora_sync.phone_pcs (
    phone text not null references kora_sync.devices on delete cascade,
    pc text not null references kora_sync.devices on delete cascade,
    primary key (phone, pc)
  );
  create index phone_pcs_pc on kora_sync.phone_pcs (pc);

  -- Consumo por dia e aparelho; depois de 90 dias some, e fica só o total acumulado em devices.
  create table kora_sync.usage_daily (
    fingerprint text not null references kora_sync.devices on delete cascade,
    day date not null,
    bytes_in bigint not null default 0,
    bytes_out bigint not null default 0,
    sessions int not null default 0,
    connected_seconds int not null default 0,
    primary key (fingerprint, day)
  );

  -- O que o admin fez: bloquear, desbloquear, remover aparelho.
  create table kora_sync.admin_log (
    id bigserial primary key,
    at timestamptz not null default now(),
    admin_id uuid not null,
    action text not null,
    account_id uuid,
    detail jsonb
  );
  `
]

export function connect(url: string): Sql {
  // prepare: false funciona também atrás do pooler do Supabase em modo transação.
  return postgres(url, { max: 4, prepare: false, idle_timeout: 60, connect_timeout: 10, onnotice: () => {} })
}

export async function migrate(sql: Sql): Promise<void> {
  await sql`create table if not exists kora_sync.migrations (version int primary key, applied_at timestamptz not null default now())`
  await sql.begin(async (tx) => {
    // Duas instâncias subindo juntas não aplicam a mesma migração duas vezes.
    await tx`lock table kora_sync.migrations in exclusive mode`
    const [applied] = await tx<{ current: number }[]>`select coalesce(max(version), 0)::int as current from kora_sync.migrations`
    for (let version = (applied?.current ?? 0) + 1; version <= MIGRATIONS.length; version++) {
      await tx.unsafe(MIGRATIONS[version - 1]!)
      await tx`insert into kora_sync.migrations (version) values (${version})`
    }
  })
}
