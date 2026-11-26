-- Esquema do banco (idempotente: pode rodar várias vezes)

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(80)  NOT NULL,
  email           VARCHAR(254) NOT NULL,
  password_hash   VARCHAR(100) NOT NULL,          -- bcrypt; a senha nunca é guardada
  failed_attempts INTEGER      NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);

-- Sessões no servidor: o cookie guarda só um token aleatório; aqui fica o HMAC dele.
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  CHAR(64)    NOT NULL UNIQUE,
  csrf_token  CHAR(64)    NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         VARCHAR(7)   NOT NULL CHECK (type IN ('income', 'expense')),
  category     VARCHAR(40)  NOT NULL,
  description  VARCHAR(120) NOT NULL,
  amount_cents BIGINT       NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 99999999999),
  occurred_on  DATE         NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_user_date_idx ON transactions (user_id, occurred_on DESC);

-- Orçamento mensal por categoria de saída (um limite por usuário+categoria, vale para todos os meses).
CREATE TABLE IF NOT EXISTS budgets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    VARCHAR(40)  NOT NULL,
  limit_cents BIGINT       NOT NULL CHECK (limit_cents > 0 AND limit_cents <= 99999999999),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT budgets_user_category_unique UNIQUE (user_id, category)
);
