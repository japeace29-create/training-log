// Итоги месяца: одни и те же цифры для сообщения бота и для карточки в приложении.
// В приложении та же арифметика написана заново (monthSummary в index.html),
// потому что карточка должна открываться без сети. Меняете здесь — меняйте там.

const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Подходы, которые идут в объём: без разминки, с записанным результатом.
// Дропсет — настоящая работа, поэтому в объёме он есть, а в рабочих подходах нет.
function counted(ex){
  return (ex.sets || []).filter(s => !s.warmup && Number(ex.isTime ? s.value1 : s.value2) > 0);
}
function working(ex){
  return counted(ex).filter(s => !s.drop);
}
// Чтобы сравнивать подходы с разным числом повторений, приводим их к оценке
// одноповторного максимума (формула Эпли).
function score(isTime, set){
  const value = Number(set.value1) || 0;
  const reps = Number(set.value2) || 0;
  if (isTime) return value;
  if (value > 0) return value * (1 + Math.max(reps, 1) / 30);
  return reps;
}
function volume(session){
  let total = 0;
  (session.exercises || []).forEach(ex => {
    if (ex.isTime) return;
    counted(ex).forEach(set => { total += (Number(set.value1) || 0) * (Number(set.value2) || 0); });
  });
  return Math.round(total);
}
function shiftMonth(month, n){
  const [year, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, m - 1 + n, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

// month — «2026-09». upToDay нужен для текущего месяца: сравниваем его не с целым
// прошлым, а с тем же числом прошлого, иначе любая неделя выглядела бы провалом.
function summarize(data, month, upToDay){
  const sessions = (Array.isArray(data.sessions) ? data.sessions : [])
    .filter(s => s && typeof s.date === 'string')
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  const stat = (m, day) => {
    const list = sessions.filter(s => s.date.slice(0, 7) === m && (!day || Number(s.date.slice(8, 10)) <= day));
    let sets = 0;
    list.forEach(s => (s.exercises || []).forEach(ex => { sets += working(ex).length; }));
    return { workouts: list.length, sets, volume: list.reduce((t, s) => t + volume(s), 0) };
  };

  // Рекорд — лучший подход упражнения за всю историю. Первый раз рекордом не считается.
  const best = new Map();
  const topBefore = new Map();
  const topMonth = new Map();
  let records = 0;
  for (const s of sessions){
    const m = s.date.slice(0, 7);
    if (m > month) break;
    (s.exercises || []).forEach(ex => {
      const sets = working(ex);
      if (!sets.length) return;
      const top = Math.max(...sets.map(x => score(ex.isTime, x)));
      const weight = ex.isTime ? 0 : Math.max(...sets.map(x => Number(x.value1) || 0));
      if (m === month){
        if (best.has(ex.name) && top > best.get(ex.name)) records++;
        if (weight > 0) topMonth.set(ex.name, Math.max(topMonth.get(ex.name) || 0, weight));
      } else if (weight > 0){
        topBefore.set(ex.name, Math.max(topBefore.get(ex.name) || 0, weight));
      }
      best.set(ex.name, Math.max(best.get(ex.name) || 0, top));
    });
  }
  // Лучший прогресс: у какого упражнения рабочий вес вырос сильнее всего.
  let progress = null;
  topMonth.forEach((to, name) => {
    const from = topBefore.get(name);
    if (!from || to <= from) return;
    const pct = Math.round((to / from - 1) * 100);
    if (!progress || to / from > progress.to / progress.from) progress = { name, from, to, pct };
  });

  const weights = (Array.isArray(data.weights) ? data.weights : [])
    .filter(w => w && typeof w.date === 'string')
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const inMonth = weights.filter(w => w.date.slice(0, 7) === month);
  let weight = null;
  if (inMonth.length){
    const end = inMonth[inMonth.length - 1];
    const before = weights.filter(w => w.date < month + '-01');
    const start = before.length ? before[before.length - 1] : inMonth[0];
    weight = { end: end.kg, delta: Math.round((end.kg - start.kg) * 10) / 10 };
  }

  return { month, ...stat(month), records, progress, weight, prev: stat(shiftMonth(month, -1), upToDay) };
}

function escapeHtml(s){
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function num(n){
  return String(Math.round(n * 10) / 10).replace('.', ',');
}
function tons(v){
  return v >= 1000 ? num(v / 1000) + ' т' : v + ' кг';
}
function percent(cur, prev){
  if (!(prev > 0)) return '';
  const p = Math.round((cur / prev - 1) * 100);
  return ` (${p >= 0 ? '+' : '−'}${Math.abs(p)}%)`;
}

function summaryText(sum){
  const monthName = MONTHS_GENITIVE[Number(sum.month.slice(5, 7)) - 1];
  const diff = sum.workouts - sum.prev.workouts;
  const lines = [
    `📊 <b>Итоги ${monthName}</b>`,
    '',
    `Тренировок: <b>${sum.workouts}</b>${sum.prev.workouts ? ` (${diff >= 0 ? '+' : '−'}${Math.abs(diff)} к прошлому месяцу)` : ''}`,
    `Подходов: <b>${sum.sets}</b>${percent(sum.sets, sum.prev.sets)}`,
    `Объём: <b>${tons(sum.volume)}</b>${percent(sum.volume, sum.prev.volume)}`
  ];
  if (sum.records) lines.push(`🏆 Новых рекордов: <b>${sum.records}</b>`);
  if (sum.progress){
    const p = sum.progress;
    lines.push(`📈 Лучший прогресс: ${escapeHtml(p.name)} — ${num(p.from)} → ${num(p.to)} кг (+${p.pct}%)`);
  }
  if (sum.weight){
    const d = sum.weight.delta;
    lines.push(`⚖️ Вес: ${num(sum.weight.end)} кг${d ? ` (${d > 0 ? '+' : '−'}${num(Math.abs(d))} за месяц)` : ' (без изменений)'}`);
  }
  lines.push('', 'Отключить это сообщение можно в настройках дневника.');
  return lines.join('\n');
}

module.exports = { summarize, summaryText, shiftMonth };
