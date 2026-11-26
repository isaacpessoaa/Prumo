'use strict';
const { z } = require('zod');

const CATEGORIES = {
  income: ['Salário', 'Freelance', 'Investimentos', 'Presentes', 'Outros'],
  expense: [
    'Moradia', 'Alimentação', 'Transporte', 'Saúde', 'Educação',
    'Lazer', 'Assinaturas', 'Compras', 'Contas', 'Outros',
  ],
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
// Senhas comuns: comparamos só as LETRAS (ex.: "Senha@12345" -> "senha"), sem barrar senhas legítimas que apenas contenham a palavra.
const WEAK_BASES = ['password', 'passw', 'senha', 'minhasenha', 'senhasenha', 'qwerty', 'qwertyuiop', 'admin', 'administrador', 'letmein', 'iloveyou', 'abcdefgh', 'welcome', 'brasil', 'mudar'];

const email = z
  .string({ error: 'Informe o e-mail.' })
  .trim()
  .toLowerCase()
  .max(254)
  .email('E-mail inválido.');

const strongPassword = z
  .string({ error: 'Informe a senha.' })
  .min(10, 'A senha precisa ter pelo menos 10 caracteres.')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'A senha é longa demais (máximo de 72 bytes).')
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), 'Use letras maiúsculas, minúsculas e números.')
  .refine((p) => !WEAK_BASES.includes(p.toLowerCase().replace(/[^a-z]/g, '')), 'Essa senha é muito comum. Escolha outra.')
  .refine((p) => !/^(.)\1+$/.test(p), 'Essa senha é muito previsível. Escolha outra.');

const registerSchema = z
  .object({
    name: z
      .string({ error: 'Informe o nome.' })
      .trim()
      .min(2, 'O nome precisa ter pelo menos 2 caracteres.')
      .max(80)
      .refine((n) => !CONTROL_CHARS.test(n), 'Nome inválido.'),
    email,
    password: strongPassword,
    passwordConfirm: z.string({ error: 'Confirme a senha.' }),
  })
  .strict()
  .refine((d) => d.password === d.passwordConfirm, { path: ['passwordConfirm'], message: 'As senhas não coincidem.' })
  .refine((d) => d.password.toLowerCase() !== d.email, { path: ['password'], message: 'A senha não pode ser igual ao e-mail.' });

const loginSchema = z
  .object({ email, password: z.string().min(1).max(128) })
  .strict();

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: strongPassword,
    newPasswordConfirm: z.string(),
  })
  .strict()
  .refine((d) => d.newPassword === d.newPasswordConfirm, { path: ['newPasswordConfirm'], message: 'As senhas não coincidem.' })
  .refine((d) => d.newPassword !== d.currentPassword, { path: ['newPassword'], message: 'A nova senha deve ser diferente da atual.' });

const deleteAccountSchema = z.object({ password: z.string().min(1).max(128) }).strict();

const amount = z
  .string({ error: 'Informe o valor.' })
  .trim()
  .regex(/^\d{1,9}([.,]\d{1,2})?$/, 'Valor inválido. Use o formato 1234,56.')
  .transform((v) => Math.round(parseFloat(v.replace(',', '.')) * 100))
  .refine((c) => c > 0 && c <= 99999999999, 'O valor deve ser maior que zero.');

const date = z
  .string({ error: 'Informe a data.' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false;
    const year = d.getUTCFullYear();
    return year >= 1990 && year <= new Date().getUTCFullYear() + 5;
  }, 'Data inválida.');

const transactionSchema = z
  .object({
    type: z.enum(['income', 'expense'], { error: 'Tipo inválido.' }),
    category: z.string().trim().max(40),
    description: z
      .string({ error: 'Informe a descrição.' })
      .trim()
      .min(1, 'Informe a descrição.')
      .max(120, 'Descrição muito longa (máximo de 120 caracteres).')
      .refine((d) => !CONTROL_CHARS.test(d), 'Descrição inválida.'),
    amount,
    date,
  })
  .strict()
  .refine((t) => CATEGORIES[t.type].includes(t.category), { path: ['category'], message: 'Categoria inválida.' });

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês inválido.');
const uuid = z.string().uuid();

// Orçamento: só categorias de SAÍDA têm limite; o valor segue as mesmas regras de um lançamento.
const budgetSchema = z
  .object({
    category: z.string({ error: 'Escolha a categoria.' }).trim().max(40),
    limit: amount,
  })
  .strict()
  .refine((b) => CATEGORIES.expense.includes(b.category), { path: ['category'], message: 'Categoria inválida.' });

const listQuerySchema = z.object({
  month: month.optional(),
  type: z.enum(['income', 'expense']).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});

module.exports = {
  CATEGORIES, registerSchema, loginSchema, changePasswordSchema, deleteAccountSchema,
  transactionSchema, budgetSchema, listQuerySchema, month, uuid,
};
