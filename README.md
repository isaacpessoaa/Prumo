# Prumo — Gestão financeira pessoal

Projeto da disciplina **Backend Frameworks**. Aplicação web com cadastro, login, sessão segura, painel financeiro (entradas, saídas, saldo, gráfico e categorias), **orçamento mensal por categoria** e logout.

**Stack:** HTML + CSS + JavaScript (frontend) · Node.js + Express (backend) · PostgreSQL (banco).

## Como rodar

Pré-requisitos: Node.js 18+ e PostgreSQL instalados.

```bash
# 1) Crie o banco e o usuário no PostgreSQL (rode no psql como administrador)
CREATE USER finapp WITH PASSWORD 'escolha_uma_senha_forte';
CREATE DATABASE finapp_dev OWNER finapp;

# 2) Instale as dependências
npm install

# 3) Configure os segredos
cp .env.example .env        # no Windows: copy .env.example .env
npm run gen-secret          # copie o resultado para SESSION_SECRET no .env
# edite o .env: DATABASE_URL com a senha que você escolheu

# 4) Crie as tabelas e inicie (rode `npm run migrate` de novo após atualizar o projeto: ele só cria o que falta)
npm run migrate
npm start                   # http://localhost:3000
```

Variável opcional no `.env`: `APP_TIMEZONE` (padrão `America/Recife`) define o fuso usado para saber qual é o "mês atual".

## Orçamento por categoria

No painel, em **Orçamento do mês**, defina um limite mensal para cada categoria de saída. A barra compara o gasto do mês exibido com o limite: verde (abaixo de 80%), amarela (80% até o limite) e vermelha (passou do limite). O limite vale para todos os meses.

| Rota | O que faz |
|---|---|
| `GET /api/budgets` | lista os limites do usuário |
| `PUT /api/budgets` | cria/atualiza `{ category, limit }` (ex.: `{ "category": "Lazer", "limit": "300,00" }`) |
| `DELETE /api/budgets/:category` | remove o limite da categoria |
| `GET /api/dashboard` | agora inclui `budgets` com gasto, percentual e status de cada limite |

Testes automatizados (segurança, transações, painel, orçamento e datas). Use um banco **separado** cujo nome termine com `_test`:

```sql
CREATE DATABASE finapp_test OWNER finapp;
```
```bash
TEST_DATABASE_URL=postgresql://finapp:SENHA@localhost:5432/finapp_test npm test
# Windows (PowerShell): $env:TEST_DATABASE_URL="postgresql://finapp:SENHA@localhost:5432/finapp_test"; npm test
```

## Estrutura (camadas)

```
server.js                   inicialização do servidor
src/app.js                  Express: cabeçalhos de segurança, rate limit, rotas, erros
src/config/env.js           lê e valida o .env (falha se faltar/for fraco)
src/db/                     pool do PostgreSQL + schema.sql
src/middleware/auth.js      sessão, CSRF, proteção de rotas
src/routes/auth.js          cadastro, login, logout, trocar senha, excluir conta
src/routes/transactions.js  CRUD de movimentações + dados do painel
src/routes/budgets.js       orçamento mensal por categoria
src/utils/                  validação (zod), datas/fuso, regra do orçamento e funções de segurança
views/                      páginas HTML (login, cadastro, painel)
public/                     CSS e JS do navegador (única pasta servida como estática)
tests/security.test.js      segurança e funcionamento geral
tests/transactions.test.js  listagem, paginação, painel e saldo acumulado
tests/budgets.test.js       API e cálculo do orçamento
tests/utils.test.js         datas/fuso e regra do orçamento (sem banco)
tests/helpers.js            servidor e cliente HTTP compartilhados pelos testes
```

## Medidas de segurança

| Risco | Como foi tratado |
|---|---|
| Senha vazada | Hash **bcrypt** (custo 12) com salt automático; a senha nunca é salva nem logada. Política: 10+ caracteres, maiúscula, minúscula, número e lista de senhas comuns. |
| Segredos expostos | Tudo sensível no `.env` (fora do Git). O app **não inicia** sem `DATABASE_URL` e `SESSION_SECRET` forte. O frontend não contém nenhum segredo (um teste verifica isso). |
| Roubo de sessão | Cookie **HttpOnly**, **SameSite=Strict**, **Secure** + prefixo `__Host-` em produção. Token aleatório de 256 bits; no banco fica só o **HMAC** dele. Expira em 8h, novo token a cada login, logout destrói a sessão no servidor. |
| Força bruta | Rate limit por IP + bloqueio da conta por 15 min após 5 erros. Mensagem igual para "e-mail inexistente" e "senha errada", com tempo de resposta equalizado. |
| CSRF | SameSite=Strict + checagem de `Origin` + exigência de JSON + token CSRF por sessão. |
| SQL Injection | Somente consultas **parametrizadas** (`$1, $2…`) e validação rígida de tudo que entra (zod; campos extras são recusados). |
| XSS | CSP restrita (`script-src 'self'`, sem inline), dados exibidos via `textContent`, respostas da API em JSON. |
| Acesso a dados de outros (IDOR) | Toda consulta filtra pelo `user_id` da **sessão**, nunca por dado enviado pelo cliente. |
| Clickjacking / sniffing | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, HSTS em produção, `no-referrer`. |
| Vazamento de arquivos | Só `public/` é estático; `.env`, `src/`, `views/` não são acessíveis (testado contra path traversal). |
| Vazamento em erros | Erros 500 devolvem mensagem genérica, sem stack trace. |
| Dependências | `npm audit` sem vulnerabilidades conhecidas na entrega. Rode `npm run audit` de tempos em tempos. |

### Limitações conhecidas
- Não há verificação de e-mail nem "esqueci minha senha" (exigiria envio de e-mail).
- A mensagem de "e-mail já cadastrado" permite, em teoria, descobrir se um e-mail existe; o rate limit reduz esse risco.
- O limite de tentativas fica na memória do processo (ok para 1 instância; com várias, use Redis).

## Publicar (ex.: Render)
1. Crie um PostgreSQL no Render e use a *Internal Database URL* em `DATABASE_URL`.
2. Variáveis: `NODE_ENV=production`, `SESSION_SECRET` (gerado), `TRUST_PROXY=1`, `DATABASE_SSL=true` (ou `no-verify` se necessário).
3. Build: `npm install` · Start: `npm run migrate && npm start`.
4. Sirva **somente por HTTPS** (o Render já faz isso).
