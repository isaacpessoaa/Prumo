'use strict';
// Regra do orçamento por categoria: compara o gasto do mês com o limite mensal.

const WARNING_PERCENT = 80; // a partir daqui o painel avisa "perto do limite"

// Retorna { percent, status }.
//   status 'over'    -> gastou MAIS que o limite
//   status 'warning' -> gastou 80% ou mais do limite (mas ainda não passou)
//   status 'ok'      -> abaixo de 80%
// Só usa inteiros (centavos) na comparação, para não ter erro de arredondamento.
function budgetStatus(limitCents, spentCents) {
  const percent = limitCents > 0 ? Math.round((spentCents * 100) / limitCents) : 0;
  let status = 'ok';
  if (spentCents > limitCents) status = 'over';
  else if (spentCents * 100 >= limitCents * WARNING_PERCENT) status = 'warning';
  return { percent, status };
}

module.exports = { WARNING_PERCENT, budgetStatus };
