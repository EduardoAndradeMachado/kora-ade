-- Roda uma vez, com o usuário administrador do Postgres, antes do primeiro deploy com contas.
-- Cria o schema do relay e um usuário que só enxerga ele. Troque a senha antes de rodar e guarde-a no
-- KORA_SYNC_DATABASE_URL do serviço kora-sync (nunca no repositório).
create role kora_sync login password 'TROCAR';
create schema kora_sync authorization kora_sync;
revoke all on schema public from kora_sync;
alter role kora_sync set search_path = kora_sync;
