'use strict';
// Datas "de calendário" calculadas no fuso do app, e não em UTC.
// Antes, `new Date().toISOString()` fazia o painel virar para o mês seguinte
// às 21h do último dia do mês no Brasil (UTC-3).
// Este módulo não depende de nada (nem do .env), para poder ser testado sozinho.

const DEFAULT_TIMEZONE = 'America/Recife';

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function partsIn(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { year: get('year'), month: get('month'), day: get('day') };
}

// 'YYYY-MM' do instante informado, no fuso informado.
function currentMonth(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const p = partsIn(now, timeZone);
  return `${p.year}-${p.month}`;
}

// 'YYYY-MM-DD' do instante informado, no fuso informado.
function today(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const p = partsIn(now, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

// Soma/subtrai meses de uma string 'YYYY-MM' (sem depender de fuso horário).
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

const firstDay = (ym) => `${ym}-01`;

module.exports = { DEFAULT_TIMEZONE, isValidTimeZone, currentMonth, today, shiftMonth, firstDay };
