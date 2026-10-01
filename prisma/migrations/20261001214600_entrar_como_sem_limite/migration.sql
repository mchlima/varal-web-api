-- "Entrar como" sem prazo e sem motivo (spec 02, RN-02.17): a sessão dura até o admin encerrar.
-- `reason` e `expires_at` ficam só no histórico dos acessos antigos.
ALTER TABLE "impersonation_sessions" ALTER COLUMN "reason" DROP NOT NULL,
ALTER COLUMN "expires_at" DROP NOT NULL;

-- Acessos antigos que já passaram dos 60 minutos e o job ainda não marcou: terminam no prazo deles.
UPDATE "impersonation_sessions"
SET "ended_at" = "expires_at", "ended_by" = 'expired', "updated_at" = now()
WHERE "ended_at" IS NULL AND "expires_at" <= now();

-- Acessos antigos ainda em andamento passam a não ter prazo, como os novos.
UPDATE "impersonation_sessions"
SET "expires_at" = NULL, "updated_at" = now()
WHERE "ended_at" IS NULL;
