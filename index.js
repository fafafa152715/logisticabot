'use strict';
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const TOKEN = process.env.BOT_TOKEN;

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '')
  .split(',').map(s => s.trim()).filter(s => s.length > 0);

function isAdmin(chatId) { return ADMIN_IDS.includes(String(chatId)); }

function notificarAdmins(mensaje, opciones = {}) {
  ADMIN_IDS.forEach(id => {
    bot.sendMessage(id, mensaje, opciones).catch(e =>
      console.error(`No se pudo notificar admin ${id}:`, e.message));
  });
}

const SHEET_BOT    = '1i7uciYXLNuZ-DPxE8H0TAQyuegqVzegE751tUNhi7Qc';
const SHEET_DIESEL = '1tEmPW1BGE7MgMXD5iOsLwq8G46GxKkT8sRuqBkdFUOk';

const bot = new TelegramBot(TOKEN, { polling: false });

// ── MENÚ DE BOTONES PARA OPERADORES ──────────────────────
const MENU_OPERADOR = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '✅ Confirmar mi viaje', callback_data: 'confirmar_viaje' }],
      [{ text: '💰 Reportar mis gastos', callback_data: 'iniciar_gastos' }],
    ]
  }
};

// ── MENÚ DE BOTONES PARA ADMINS ──────────────────────────
const MENU_ADMIN = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📋 Ver viajes', callback_data: 'ver_viajes' },
       { text: '➕ Nuevos viajes', callback_data: 'nuevos_viajes' }],
      [{ text: '👥 Operadores', callback_data: 'ver_operadores' },
       { text: '⛽ Registrar diésel', callback_data: 'iniciar_diesel' }],
      [{ text: '📊 Resumen', callback_data: 'ver_resumen' }],
    ]
  }
};

// ── PREGUNTAS ────────────────────────────────────────────
const PREGUNTAS_GASTOS = [
  { campo: 'destino',   pregunta: '📍 ¿Origen y destino?\nEjemplo: Irapuato - Guadalajara' },
  { campo: 'dias',      pregunta: '📅 ¿Cuántos días duró el viaje?' },
  { campo: 'anticipo',  pregunta: '💵 ¿Cuánto de anticipo te dieron?' },
  { campo: 'comida',    pregunta: '🍽️ ¿Cuánto gastaste en comidas?\n(Si fue $0 escribe 0)' },
  { campo: 'aguas',     pregunta: '💧 ¿Cuánto gastaste en aguas?\n(Si fue $0 escribe 0)' },
  { campo: 'casetas',   pregunta: '🛣️ ¿Cuánto pagaste en casetas?\n(Si fue $0 escribe 0)' },
  { campo: 'pension',   pregunta: '🅿️ ¿Cuánto de pensión?\n(Si fue $0 escribe 0)' },
  { campo: 'federales', pregunta: '👮 ¿Cuánto de federales?\n(Si fue $0 escribe 0)' },
  { campo: 'otros',     pregunta: '📦 ¿Algún otro gasto?\n(Si fue $0 escribe 0)' },
];

const PREGUNTAS_DIESEL = [
  { campo: 'operador', pregunta: '👤 ¿Qué operador? (Victor, Paco, Rafa, Samuel)' },
  { campo: 'tracto',   pregunta: '🚛 ¿Número de tracto?' },
  { campo: 'km_nuevo', pregunta: '📏 Kilometraje actual del odómetro' },
  { campo: 'km_ant',   pregunta: '📏 Kilometraje anterior' },
  { campo: 'litros',   pregunta: '⛽ ¿Cuántos litros cargó?' },
  { campo: 'vale',     pregunta: '🔢 ¿Número de vale?' },
];

const CAMPOS_NUMERICOS = ['anticipo','comida','aguas','casetas','pension','federales','bono','otros','dias','km_nuevo','km_ant','litros'];

function esNumeroValido(txt) { return /^\d+(\.\d+)?$/.test(txt.trim()); }
function parsearNumero(v) { return parseFloat(v) || 0; }

// ── GOOGLE SHEETS ────────────────────────────────────────
function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function appendRow(sheetId, tab, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] },
  });
}

async function getRows(sheetId, tab) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tab}!A1:Z1000`,
  });
  return res.data.values || [];
}

async function getOperadores() {
  const rows = await getRows(SHEET_BOT, 'Operadores');
  const ops = {};
  rows.forEach(r => {
    if (r[0] && r[0] !== 'chatId') ops[r[0]] = { chatId: r[0], nombre: r[1], tracto: r[2] };
  });
  return ops;
}

async function saveOperador(chatId, nombre, tracto) {
  const rows = await getRows(SHEET_BOT, 'Operadores');
  if (rows.length === 0) await appendRow(SHEET_BOT, 'Operadores', ['chatId','nombre','tracto']);
  const existing = rows.findIndex(r => r[0] === String(chatId));
  if (existing >= 0) {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_BOT,
      range: `Operadores!A${existing + 1}:C${existing + 1}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[String(chatId), nombre, tracto]] },
    });
  } else {
    await appendRow(SHEET_BOT, 'Operadores', [String(chatId), nombre, tracto]);
  }
}

async function getViajes() {
  const rows = await getRows(SHEET_BOT, 'Viajes');
  return rows
    .filter(r => r[0] && r[0] !== 'idx')
    .map(r => ({ idx: r[0], fecha: r[1], cliente: r[2], destino: r[3], hora: r[4], operador: r[5] || '' }));
}

async function saveViaje(v) {
  const rows = await getRows(SHEET_BOT, 'Viajes');
  if (rows.length === 0) await appendRow(SHEET_BOT, 'Viajes', ['idx','fecha','cliente','destino','hora','operador']);
  const idx = rows.filter(r => r[0] !== 'idx').length + 1;
  await appendRow(SHEET_BOT, 'Viajes', [idx, v.fecha, v.cliente, v.destino, v.hora, v.operador]);
}

async function ensureGastosHeader() {
  const rows = await getRows(SHEET_BOT, 'Gastos');
  if (rows.length === 0) {
    await appendRow(SHEET_BOT, 'Gastos', [
      'Fecha','Operador','Tracto','Destino','Días',
      'Anticipo','Comida','Aguas','Casetas','Pensión',
      'Federales','Bono','Otros','Total','Diferencia'
    ]);
  }
}

// ── ESTADO DE USUARIO ────────────────────────────────────
const userState = {};

// ── INICIO BOT ───────────────────────────────────────────
async function iniciarBot() {
  try {
    await bot.deleteWebHook();
    await new Promise(r => setTimeout(r, 2000));
    bot.startPolling({ interval: 300, params: { timeout: 10 } });
    console.log('🚛 Bot Transportes Regis iniciado...');
    console.log(`👥 Administradores: ${ADMIN_IDS.length}`);
    ADMIN_IDS.forEach(id => console.log(`   - Admin ID: ${id}`));
  } catch (e) {
    console.error('Error iniciando bot:', e.message);
    process.exit(1);
  }
}

// ── COMANDO /start ────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  if (isAdmin(chatId)) {
    bot.sendMessage(chatId, `👋 *Bienvenido Admin!*\n\n¿Qué quieres hacer?`, { parse_mode: 'Markdown', ...MENU_ADMIN });
  } else {
    const ops = await getOperadores();
    const operador = ops[String(chatId)];
    if (operador) {
      bot.sendMessage(chatId,
        `👋 Hola *${operador.nombre}* 🚛\n\n¿Qué necesitas?`,
        { parse_mode: 'Markdown', ...MENU_OPERADOR });
    } else {
      bot.sendMessage(chatId,
        `👋 Bienvenido al Bot de Transportes Regis 🚛\n\nPrimero regístrate con tu nombre y tracto:\n\n/registrar NOMBRE TRACTO\n\nEjemplo:\n/registrar Rafael 9`);
    }
  }
});

// ── COMANDO /registrar ────────────────────────────────────
bot.onText(/\/registrar (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(' ');
  if (parts.length < 2) {
    return bot.sendMessage(chatId, '❌ Ejemplo correcto:\n/registrar Rafael 9');
  }
  const nombre = parts[0];
  const tracto = parts[1];
  try {
    await saveOperador(chatId, nombre, tracto);
    bot.sendMessage(chatId,
      `✅ Registrado como *${nombre}* — Tracto #${tracto}\n\n¿Qué necesitas?`,
      { parse_mode: 'Markdown', ...MENU_OPERADOR });
    notificarAdmins(`🚛 Nuevo operador: *${nombre}* — Tracto #${tracto}`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '❌ Error al registrar. Intenta de nuevo.');
  }
});

// ── CALLBACKS DE BOTONES ──────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;

  // Confirmar siempre el callback para quitar el "reloj" de Telegram
  bot.answerCallbackQuery(query.id);

  // ── OPERADOR: Confirmar viaje ──
  if (data === 'confirmar_viaje') {
    const ops = await getOperadores();
    const operador = ops[String(chatId)];
    if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado.\nUsa /registrar NOMBRE TRACTO');
    const viajes = await getViajes();
    const miViaje = viajes.find(v => v.operador === operador.nombre && v.confirmado !== 'si');
    if (!miViaje) {
      return bot.sendMessage(chatId,
        '📋 No tienes viajes pendientes por confirmar.\n\n¿Qué más necesitas?',
        MENU_OPERADOR);
    }
    // Guardar confirmación
    try {
      const rows = await getRows(SHEET_BOT, 'Viajes');
      const rowIdx = rows.findIndex(r => r[0] === String(miViaje.idx));
      if (rowIdx >= 0) {
        const sheets = getSheetsClient();
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_BOT,
          range: `Viajes!G${rowIdx + 1}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [['si']] },
        });
      }
    } catch(e) { console.error('Error confirmando viaje:', e.message); }

    notificarAdmins(
      `✅ *${operador.nombre}* confirmó su viaje\n📍 ${miViaje.destino} — ${miViaje.fecha}`,
      { parse_mode: 'Markdown' });
    bot.sendMessage(chatId,
      `✅ ¡Viaje confirmado!\n\n📍 *${miViaje.destino}*\n📅 ${miViaje.fecha}\n\n¡Buen viaje! 🚛`,
      { parse_mode: 'Markdown' });
    return;
  }

  // ── OPERADOR: Iniciar gastos ──
  if (data === 'iniciar_gastos') {
    const ops = await getOperadores();
    const operador = ops[String(chatId)];
    if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado.\nUsa /registrar NOMBRE TRACTO');
    userState[chatId] = { estado: 'gastos', paso: 0, datos: {} };
    bot.sendMessage(chatId,
      `💰 *Reporte de Gastos*\n\n${PREGUNTAS_GASTOS[0].pregunta}`,
      { parse_mode: 'Markdown' });
    return;
  }

  // ── ADMIN: Ver viajes ──
  if (data === 'ver_viajes') {
    if (!isAdmin(chatId)) return;
    const viajes = await getViajes();
    if (viajes.length === 0) {
      return bot.sendMessage(chatId, '❌ No hay viajes registrados.', MENU_ADMIN);
    }
    let lista = `📋 *Viajes registrados:*\n\n`;
    viajes.forEach(v => {
      const conf = v.confirmado === 'si' ? '✅' : '⏳';
      lista += `${conf} *${v.idx}.* ${v.fecha} | ${v.cliente} | ${v.destino}`;
      if (v.operador) lista += ` | ${v.operador}`;
      lista += '\n';
    });
    lista += `\nPara asignar: /asignar NUMERO NOMBRE`;
    bot.sendMessage(chatId, lista, { parse_mode: 'Markdown', ...MENU_ADMIN });
    return;
  }

  // ── ADMIN: Nuevos viajes ──
  if (data === 'nuevos_viajes') {
    if (!isAdmin(chatId)) return;
    userState[chatId] = { estado: 'esperando_viajes' };
    bot.sendMessage(chatId,
      `📋 *Agregar viajes*\n\nManda uno por línea con este formato:\n\`Fecha | Cliente | Destino | Hora\`\n\nEjemplo:\n\`19/Abr | Kerry | Guadalajara | 8:00am\`\n\nCuando termines escribe *fin*`,
      { parse_mode: 'Markdown' });
    return;
  }

  // ── ADMIN: Ver operadores ──
  if (data === 'ver_operadores') {
    if (!isAdmin(chatId)) return;
    const ops = await getOperadores();
    if (Object.keys(ops).length === 0) {
      return bot.sendMessage(chatId, '❌ No hay operadores registrados.', MENU_ADMIN);
    }
    let lista = `👥 *Operadores registrados:*\n\n`;
    Object.values(ops).forEach(op => {
      lista += `🚛 *${op.nombre}* — Tracto #${op.tracto}\n`;
    });
    bot.sendMessage(chatId, lista, { parse_mode: 'Markdown', ...MENU_ADMIN });
    return;
  }

  // ── ADMIN: Iniciar diesel ──
  if (data === 'iniciar_diesel') {
    if (!isAdmin(chatId)) return;
    userState[chatId] = { estado: 'diesel', paso: 0, datos: {} };
    bot.sendMessage(chatId,
      `⛽ *Registrar Diésel*\n\n${PREGUNTAS_DIESEL[0].pregunta}`,
      { parse_mode: 'Markdown' });
    return;
  }

  // ── ADMIN: Ver resumen ──
  if (data === 'ver_resumen') {
    if (!isAdmin(chatId)) return;
    const ops    = await getOperadores();
    const viajes = await getViajes();
    bot.sendMessage(chatId,
      `📊 *Resumen*\n\n🚛 Operadores: ${Object.keys(ops).length}\n📋 Viajes: ${viajes.length}`,
      { parse_mode: 'Markdown', ...MENU_ADMIN });
    return;
  }
});

// ── COMANDO /asignar ──────────────────────────────────────
bot.onText(/\/asignar (\d+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  const idx    = match[1];
  const nombre = match[2].trim();
  try {
    const rows   = await getRows(SHEET_BOT, 'Viajes');
    const rowIdx = rows.findIndex(r => r[0] === idx);
    if (rowIdx < 0) return bot.sendMessage(chatId, `❌ No existe el viaje #${idx}`);

    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_BOT,
      range: `Viajes!F${rowIdx + 1}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[nombre]] },
    });

    const viaje  = rows[rowIdx];
    const ops    = await getOperadores();
    const op     = Object.values(ops).find(o => o.nombre.toLowerCase() === nombre.toLowerCase());

    bot.sendMessage(chatId, `✅ Viaje #${idx} asignado a *${nombre}*`, { parse_mode: 'Markdown', ...MENU_ADMIN });

    if (op) {
      bot.sendMessage(op.chatId,
        `🚛 *¡Tienes un nuevo viaje!*\n\n📍 *Destino:* ${viaje[3]}\n📅 *Fecha:* ${viaje[1]}\n🕐 *Hora:* ${viaje[4] || 'Por confirmar'}\n🏭 *Cliente:* ${viaje[2]}\n\n¿Puedes confirmarlo?`,
        { parse_mode: 'Markdown', ...MENU_OPERADOR });
    }
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '❌ Error al asignar. Intenta de nuevo.');
  }
});

// ── FLUJOS DE TEXTO ───────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const estado = userState[chatId]?.estado;
  if (!msg.text || msg.text.startsWith('/')) return;

  // ── Admin: Agregar viajes ──
  if (estado === 'esperando_viajes') {
    if (msg.text.toLowerCase() === 'fin') {
      userState[chatId] = { estado: null };
      const viajes = await getViajes();
      if (viajes.length === 0) return bot.sendMessage(chatId, '❌ No hay viajes.', MENU_ADMIN);
      let lista = `✅ *Viajes registrados:*\n\n`;
      viajes.forEach(v => { lista += `${v.idx}. ${v.fecha} | ${v.cliente} | ${v.destino}\n`; });
      lista += `\nUsa /asignar NUMERO NOMBRE`;
      return bot.sendMessage(chatId, lista, { parse_mode: 'Markdown', ...MENU_ADMIN });
    }
    const lineas = msg.text.split('\n').filter(l => l.trim());
    let agregados = 0;
    for (const linea of lineas) {
      const partes = linea.split('|').map(p => p.trim());
      if (partes.length >= 3) {
        await saveViaje({ fecha: partes[0], cliente: partes[1], destino: partes[2], hora: partes[3] || 'Sin cita', operador: '' });
        agregados++;
      }
    }
    return bot.sendMessage(chatId, `✅ ${agregados} viaje(s) agregado(s). Sigue agregando o escribe *fin*`, { parse_mode: 'Markdown' });
  }

  // ── Operador: Gastos ──
  if (estado === 'gastos') {
    const paso  = userState[chatId].paso;
    const campo = PREGUNTAS_GASTOS[paso].campo;
    const texto = msg.text.trim();

    if (CAMPOS_NUMERICOS.includes(campo) && !esNumeroValido(texto)) {
      bot.sendMessage(chatId,
        `❌ Solo números.\n\n${PREGUNTAS_GASTOS[paso].pregunta}\n\nEjemplo: 250 o 0`,
        { parse_mode: 'Markdown' });
      return;
    }

    userState[chatId].datos[campo] = texto;
    const sig = paso + 1;

    if (sig < PREGUNTAS_GASTOS.length) {
      userState[chatId].paso = sig;
      bot.sendMessage(chatId, PREGUNTAS_GASTOS[sig].pregunta);
    } else {
      // Guardar gastos
      const ops      = await getOperadores();
      const operador = ops[String(chatId)];
      const d        = userState[chatId].datos;
      userState[chatId] = { estado: null };
      const fecha    = new Date().toLocaleDateString('es-MX');

      const total     = ['comida','aguas','casetas','pension','federales','bono','otros']
        .reduce((s, k) => s + parsearNumero(d[k]), 0);
      const anticipo  = parsearNumero(d.anticipo);
      const diferencia = anticipo - total;

      try {
        await ensureGastosHeader();
        await appendRow(SHEET_BOT, 'Gastos', [
          fecha, operador.nombre, operador.tracto, d.destino, d.dias,
          anticipo, parsearNumero(d.comida), parsearNumero(d.aguas),
          parsearNumero(d.casetas), parsearNumero(d.pension),
          parsearNumero(d.federales), 0,
          parsearNumero(d.otros), total, diferencia
        ]);
      } catch (e) {
        console.error('❌ ERROR guardando gastos:', e.message);
        bot.sendMessage(chatId, '⚠️ Error guardando gastos. Avisa a Fabiola.');
      }

      const signo   = diferencia >= 0 ? '✅' : '⚠️';
      const resumen =
        `${signo} *Gastos registrados*\n\n` +
        `📍 ${d.destino}\n` +
        `📅 ${d.dias} día(s)\n\n` +
        `💵 Anticipo:   $${anticipo.toFixed(2)}\n` +
        `🍽️ Comidas:    $${parsearNumero(d.comida).toFixed(2)}\n` +
        `💧 Aguas:      $${parsearNumero(d.aguas).toFixed(2)}\n` +
        `🛣️ Casetas:    $${parsearNumero(d.casetas).toFixed(2)}\n` +
        `🅿️ Pensión:    $${parsearNumero(d.pension).toFixed(2)}\n` +
        `👮 Federales:  $${parsearNumero(d.federales).toFixed(2)}\n` +
        `📦 Otros:      $${parsearNumero(d.otros).toFixed(2)}\n\n` +
        `💰 *Total:     $${total.toFixed(2)}*\n` +
        `${diferencia >= 0 ? '✅' : '🔴'} *Diferencia:  $${diferencia.toFixed(2)}*`;

      bot.sendMessage(chatId, resumen, { parse_mode: 'Markdown', ...MENU_OPERADOR });

      const alertaAdmin =
        `💰 *Gastos de ${operador.nombre}*\n` +
        `📍 ${d.destino} | ${d.dias} día(s)\n` +
        `Anticipo: $${anticipo} | Total: $${total.toFixed(2)}\n` +
        `${diferencia >= 0 ? '✅' : '🔴'} Diferencia: $${diferencia.toFixed(2)}`;
      notificarAdmins(alertaAdmin, { parse_mode: 'Markdown' });

      if (diferencia < 0) {
        notificarAdmins(
          `⚠️ *ALERTA — Diferencia negativa*\n${operador.nombre} gastó $${Math.abs(diferencia).toFixed(2)} más del anticipo.`,
          { parse_mode: 'Markdown' });
      }
    }
    return;
  }

  // ── Admin: Diesel ──
  if (estado === 'diesel') {
    const paso  = userState[chatId].paso;
    const campo = PREGUNTAS_DIESEL[paso].campo;
    userState[chatId].datos[campo] = msg.text.trim();
    const sig = paso + 1;

    if (sig < PREGUNTAS_DIESEL.length) {
      userState[chatId].paso = sig;
      bot.sendMessage(chatId, PREGUNTAS_DIESEL[sig].pregunta);
    } else {
      const d     = userState[chatId].datos;
      userState[chatId] = { estado: null };
      const fecha = new Date().toLocaleDateString('es-MX');
      const difKM = parsearNumero(d.km_nuevo) - parsearNumero(d.km_ant);
      const rend  = difKM > 0 ? (difKM / parsearNumero(d.litros)).toFixed(2) : '—';

      await appendRow(SHEET_DIESEL, 'Diesel', [
        fecha, d.vale, d.tracto,
        parsearNumero(d.km_nuevo), parsearNumero(d.km_ant),
        difKM, parsearNumero(d.litros), rend
      ]);

      bot.sendMessage(chatId,
        `⛽ *Diésel registrado*\n\nTracto: #${d.tracto}\nKM recorridos: ${difKM}\nRendimiento: ${rend} km/lt`,
        { parse_mode: 'Markdown', ...MENU_ADMIN });
    }
    return;
  }

  // Mensaje no reconocido → mostrar menú
  if (isAdmin(chatId)) {
    bot.sendMessage(chatId, '¿Qué necesitas?', MENU_ADMIN);
  } else {
    const ops = await getOperadores();
    const operador = ops[String(chatId)];
    if (operador) {
      bot.sendMessage(chatId, `¿Qué necesitas, ${operador.nombre}?`, MENU_OPERADOR);
    }
  }
});

// ── FOTOS ─────────────────────────────────────────────────
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Para reportar gastos usa el menú 👇', MENU_OPERADOR);
});

iniciarBot();
