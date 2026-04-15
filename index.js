const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

const SHEET_BOT = '1i7uciYXLNuZ-DPxE8H0TAQyuegqVzegE751tUNhi7Qc';
const SHEET_DIESEL = '1tEmPW1BGE7MgMXD5iOsLwq8G46GxKkT8sRuqBkdFUOk';

const bot = new TelegramBot(TOKEN, { polling: false });

async function iniciarBot() {
  try {
    await bot.deleteWebHook();
    await new Promise(r => setTimeout(r, 2000));
    bot.startPolling({ interval: 300, params: { timeout: 10 } });
    console.log('🚛 Bot Transportes Regis iniciado...');
  } catch (e) {
    console.error('Error iniciando bot:', e.message);
    process.exit(1);
  }
}

const userState = {};

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
    if (r[0] && r[0] !== 'chatId') {
      ops[r[0]] = { chatId: r[0], nombre: r[1], tracto: r[2] };
    }
  });
  return ops;
}

async function saveOperador(chatId, nombre, tracto) {
  const rows = await getRows(SHEET_BOT, 'Operadores');
  if (rows.length === 0) {
    await appendRow(SHEET_BOT, 'Operadores', ['chatId', 'nombre', 'tracto']);
  }
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
  if (rows.length <= 1) return [];
  return rows.slice(1).map((r, i) => ({
    idx: i + 1,
    fecha: r[0], cliente: r[1], destino: r[2],
    hora: r[3], operador: r[4] || 'Sin asignar',
  }));
}

async function saveViaje(viaje) {
  const rows = await getRows(SHEET_BOT, 'Viajes');
  if (rows.length === 0) {
    await appendRow(SHEET_BOT, 'Viajes', ['fecha', 'cliente', 'destino', 'hora', 'operador']);
  }
  await appendRow(SHEET_BOT, 'Viajes', [viaje.fecha, viaje.cliente, viaje.destino, viaje.hora, viaje.operador || '']);
}

async function asignarOperadorViaje(idx, nombreOperador) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_BOT,
    range: `Viajes!E${idx + 2}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[nombreOperador]] },
  });
}

async function ensureGastosHeader() {
  const rows = await getRows(SHEET_BOT, 'Gastos');
  if (rows.length === 0) {
    await appendRow(SHEET_BOT, 'Gastos', [
      'Fecha', 'Operador', 'Tracto', 'Destino', 'Días',
      'Anticipo', 'Comida', 'Aguas', 'Casetas',
      'Pensión', 'Federales', 'Bono', 'Otros',
      'Total', 'Diferencia'
    ]);
  }
}

// ── VALIDACIÓN NUMÉRICA ──────────────────────────────────
function esNumeroValido(texto) {
  const limpio = texto.trim().replace(',', '.');
  return !isNaN(parseFloat(limpio)) && isFinite(limpio);
}

function parsearNumero(texto) {
  return parseFloat(texto.trim().replace(',', '.')) || 0;
}

// Campos que requieren validación numérica
const CAMPOS_NUMERICOS = ['dias', 'comida', 'aguas', 'casetas', 'pension', 'federales', 'bono', 'otros', 'anticipo'];

const PREGUNTAS_GASTOS = [
  { campo: 'destino',   pregunta: '📍 ¿A dónde fuiste?' },
  { campo: 'dias',      pregunta: '📅 ¿Cuántos días duró el viaje?' },
  { campo: 'comida',    pregunta: '🍽️ Comida ($) — escribe 0 si nada' },
  { campo: 'aguas',     pregunta: '💧 Aguas ($) — escribe 0 si nada' },
  { campo: 'casetas',   pregunta: '🛣️ Casetas ($) — escribe 0 si nada' },
  { campo: 'pension',   pregunta: '🅿️ Pensión ($) — escribe 0 si nada' },
  { campo: 'federales', pregunta: '🚔 Federales ($) — escribe 0 si nada' },
  { campo: 'bono',      pregunta: '⭐ Bono ($) — escribe 0 si nada' },
  { campo: 'otros',     pregunta: '📦 Otros ($) — escribe 0 si nada' },
  { campo: 'anticipo',  pregunta: '💵 ¿Cuánto de anticipo recibiste?' },
];

const PREGUNTAS_DIESEL = [
  { campo: 'operador', pregunta: '👤 ¿Qué operador? (Victor, Paco, Rafa, Samuel)' },
  { campo: 'tracto',   pregunta: '🚛 ¿Número de tracto?' },
  { campo: 'km_nuevo', pregunta: '📏 Kilometraje actual del odómetro' },
  { campo: 'km_ant',   pregunta: '📏 Kilometraje anterior (del registro anterior)' },
  { campo: 'litros',   pregunta: '⛽ ¿Cuántos litros cargó?' },
  { campo: 'vale',     pregunta: '🔢 ¿Número de vale?' },
];

const PREGUNTAS_SELLO = [
  { campo: 'num_sello', pregunta: '🔒 ¿Número de sello?' },
  { campo: 'cliente',   pregunta: '🏭 ¿Cliente?' },
  { campo: 'destino',   pregunta: '📍 ¿Destino?' },
  { campo: 'caja',      pregunta: '📦 ¿Número de caja?' },
];

// ── COMANDOS ──────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const isAdmin = String(chatId) === String(ADMIN_ID);
  if (isAdmin) {
    bot.sendMessage(chatId,
      `👋 *Bienvenido Admin!*\n\n📋 *Comandos:*\n\n/nuevos_viajes - Registrar viajes\n/ver_viajes - Ver viajes\n/operadores - Ver operadores\n/diesel - Registrar diésel\n/resumen - Ver resumen`,
      { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId,
      `👋 Bienvenido al Bot de Transportes Regis 🚛\n\nPara registrarte:\n/registrar NOMBRE TRACTO\n\nEjemplo: /registrar Rafael 9`);
  }
});

bot.onText(/\/registrar (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(' ');
  if (parts.length < 2) return bot.sendMessage(chatId, '❌ Usa: /registrar NOMBRE TRACTO\nEjemplo: /registrar Rafael 9');
  const nombre = parts[0];
  const tracto = parts[1];
  try {
    await saveOperador(chatId, nombre, tracto);
    bot.sendMessage(chatId, `✅ Registrado como *${nombre}* - Tracto #${tracto}\n\nComandos:\n/gastos - Reportar gastos\n/sello - Reportar sello`, { parse_mode: 'Markdown' });
    if (ADMIN_ID) bot.sendMessage(ADMIN_ID, `🚛 Nuevo operador: *${nombre}* - Tracto #${tracto}`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '❌ Error al registrar. Intenta de nuevo.');
  }
});

bot.onText(/\/operadores/, async (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  const ops = await getOperadores();
  if (Object.keys(ops).length === 0) return bot.sendMessage(chatId, '❌ No hay operadores registrados.');
  let lista = '🚛 *Operadores:*\n\n';
  Object.values(ops).forEach(op => { lista += `• ${op.nombre} - Tracto #${op.tracto}\n`; });
  bot.sendMessage(chatId, lista, { parse_mode: 'Markdown' });
});

bot.onText(/\/nuevos_viajes/, (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  userState[chatId] = { estado: 'esperando_viajes' };
  bot.sendMessage(chatId,
    `📋 *Viajes de la semana*\n\nEnvía uno por línea:\nFECHA | CLIENTE | DESTINO | HORA\n\nEjemplo:\nLunes 13 | Conagra | Local | 4:30pm\n\nEscribe *fin* cuando termines`,
    { parse_mode: 'Markdown' });
});

bot.onText(/\/ver_viajes/, async (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  const viajes = await getViajes();
  if (viajes.length === 0) return bot.sendMessage(chatId, '❌ No hay viajes.');
  let lista = '📋 *Viajes:*\n\n';
  viajes.forEach(v => { lista += `${v.idx}. ${v.fecha} | ${v.cliente} | ${v.destino} | ${v.hora} | 👤 ${v.operador}\n`; });
  lista += `\n/asignar NUMERO NOMBRE`;
  bot.sendMessage(chatId, lista, { parse_mode: 'Markdown' });
});

bot.onText(/\/asignar (\d+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  const idx = parseInt(match[1]);
  const nombreOperador = match[2].trim();
  const viajes = await getViajes();
  const viaje = viajes.find(v => v.idx === idx);
  if (!viaje) return bot.sendMessage(chatId, '❌ Número incorrecto.');
  await asignarOperadorViaje(idx, nombreOperador);
  const ops = await getOperadores();
  const entry = Object.values(ops).find(op => op.nombre.toLowerCase() === nombreOperador.toLowerCase());
  if (entry) {
    bot.sendMessage(entry.chatId,
      `🚛 *Viaje asignado:*\n\n📅 ${viaje.fecha}\n🏭 ${viaje.cliente}\n📍 ${viaje.destino}\n🕐 ${viaje.hora}\n\nResponde /confirmar cuando estés listo`,
      { parse_mode: 'Markdown' });
    bot.sendMessage(chatId, `✅ Asignado a *${nombreOperador}*.`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `⚠️ Asignado pero *${nombreOperador}* no está registrado.`, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/confirmar/, async (msg) => {
  const chatId = msg.chat.id;
  const ops = await getOperadores();
  const operador = ops[String(chatId)];
  if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado.');
  userState[chatId] = { estado: 'esperando_remision' };
  bot.sendMessage(chatId, `✅ Confirmado!\n\nEnvía el número de *remisión* y *caja*\nEjemplo: Remisión 12345, Caja 67`, { parse_mode: 'Markdown' });
});

bot.onText(/\/gastos/, async (msg) => {
  const chatId = msg.chat.id;
  const ops = await getOperadores();
  const operador = ops[String(chatId)];
  if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado. Usa /registrar NOMBRE TRACTO');
  userState[chatId] = { estado: 'gastos', paso: 0, datos: {} };
  bot.sendMessage(chatId, `💰 *Reporte de Gastos*\n\n${PREGUNTAS_GASTOS[0].pregunta}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/diesel/, async (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return bot.sendMessage(chatId, '❌ Solo el administrador registra diésel.');
  userState[chatId] = { estado: 'diesel', paso: 0, datos: {} };
  bot.sendMessage(chatId, `⛽ *Registrar Diésel*\n\n${PREGUNTAS_DIESEL[0].pregunta}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/sello/, async (msg) => {
  const chatId = msg.chat.id;
  const ops = await getOperadores();
  const operador = ops[String(chatId)];
  if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado. Usa /registrar NOMBRE TRACTO');
  userState[chatId] = { estado: 'sello', paso: 0, datos: {} };
  bot.sendMessage(chatId, `🔒 *Registrar Sello*\n\n${PREGUNTAS_SELLO[0].pregunta}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/resumen/, async (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  try {
    const ops = await getOperadores();
    const viajes = await getViajes();
    bot.sendMessage(chatId, `📊 *Resumen*\n\n🚛 Operadores: ${Object.keys(ops).length}\n📋 Viajes: ${viajes.length}`, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(chatId, '❌ Error.');
  }
});

// ── FLUJOS DE CONVERSACIÓN ────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const estado = userState[chatId]?.estado;
  if (!msg.text || msg.text.startsWith('/')) return;

  // ── Registrar viajes ──
  if (estado === 'esperando_viajes') {
    if (msg.text.toLowerCase() === 'fin') {
      userState[chatId] = { estado: null };
      const viajes = await getViajes();
      if (viajes.length === 0) return bot.sendMessage(chatId, '❌ No hay viajes.');
      let lista = `✅ *Viajes registrados:*\n\n`;
      viajes.forEach(v => { lista += `${v.idx}. ${v.fecha} | ${v.cliente} | ${v.destino} | ${v.hora}\n`; });
      lista += `\nUsa /asignar NUMERO NOMBRE`;
      return bot.sendMessage(chatId, lista, { parse_mode: 'Markdown' });
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
    return bot.sendMessage(chatId, `✅ ${agregados} viajes agregados. Sigue o escribe *fin*`, { parse_mode: 'Markdown' });
  }

  // ── Remisión ──
  if (estado === 'esperando_remision') {
    const ops = await getOperadores();
    const operador = ops[String(chatId)];
    userState[chatId] = { estado: null };
    const fecha = new Date().toLocaleDateString('es-MX');
    await appendRow(SHEET_BOT, 'Remisiones', [fecha, operador.nombre, operador.tracto, msg.text]);
    if (ADMIN_ID) bot.sendMessage(ADMIN_ID, `📦 *${operador.nombre}* - Tracto #${operador.tracto}\n\n${msg.text}`, { parse_mode: 'Markdown' });
    bot.sendMessage(chatId, '✅ Enviado. ¡Buen viaje! 🚛');
    return;
  }

  // ── Gastos ──
  if (estado === 'gastos') {
    const paso = userState[chatId].paso;
    const campo = PREGUNTAS_GASTOS[paso].campo;
    const texto = msg.text.trim();

    // Validación numérica para campos que lo requieren
    if (CAMPOS_NUMERICOS.includes(campo) && !esNumeroValido(texto)) {
      bot.sendMessage(chatId, `❌ *Solo números por favor.*\n\n${PREGUNTAS_GASTOS[paso].pregunta}\n\nEjemplo: 250 o 0`, { parse_mode: 'Markdown' });
      return;
    }

    userState[chatId].datos[campo] = texto;
    const sig = paso + 1;

    if (sig < PREGUNTAS_GASTOS.length) {
      userState[chatId].paso = sig;
      bot.sendMessage(chatId, PREGUNTAS_GASTOS[sig].pregunta);
    } else {
      const ops = await getOperadores();
      const operador = ops[String(chatId)];
      const d = userState[chatId].datos;
      userState[chatId] = { estado: null };
      const fecha = new Date().toLocaleDateString('es-MX');

      const total = ['comida', 'aguas', 'casetas', 'pension', 'federales', 'bono', 'otros']
        .reduce((s, k) => s + parsearNumero(d[k]), 0);
      const anticipo = parsearNumero(d.anticipo);
      const diferencia = anticipo - total;

      try {
        await ensureGastosHeader();
        await appendRow(SHEET_BOT, 'Gastos', [
          fecha, operador.nombre, operador.tracto, d.destino, d.dias,
          anticipo, parsearNumero(d.comida), parsearNumero(d.aguas),
          parsearNumero(d.casetas), parsearNumero(d.pension),
          parsearNumero(d.federales), parsearNumero(d.bono),
          parsearNumero(d.otros), total, diferencia
        ]);
      } catch (e) {
        console.error('❌ ERROR guardando gastos:', e.message);
        bot.sendMessage(chatId, '⚠️ Error guardando gastos. Avisa al administrador.');
        return;
      }

      // Determinar estado de la diferencia
      const estadoDif = diferencia >= 0
        ? `✅ *Te sobran: $${diferencia.toFixed(2)}*`
        : `🔴 *Debes: $${Math.abs(diferencia).toFixed(2)}*`;

      const resumen = `✅ *Gastos guardados*\n\n👤 ${operador.nombre} - Tracto #${operador.tracto}\n📍 ${d.destino} (${d.dias} día/s)\n📅 ${fecha}\n\n🍽️ Comida: $${parsearNumero(d.comida)}\n💧 Aguas: $${parsearNumero(d.aguas)}\n🛣️ Casetas: $${parsearNumero(d.casetas)}\n🅿️ Pensión: $${parsearNumero(d.pension)}\n🚔 Federales: $${parsearNumero(d.federales)}\n⭐ Bono: $${parsearNumero(d.bono)}\n📦 Otros: $${parsearNumero(d.otros)}\n💵 Anticipo: $${anticipo}\n\n*Total gastos: $${total.toFixed(2)}*\n${estadoDif}`;

      bot.sendMessage(chatId, resumen, { parse_mode: 'Markdown' });

      // ── ALERTA AL ADMIN si diferencia negativa ──
      if (ADMIN_ID && diferencia < 0) {
        const alerta = `⚠️ *ALERTA — Diferencia negativa*\n\n👤 ${operador.nombre} - Tracto #${operador.tracto}\n📍 ${d.destino}\n📅 ${fecha}\n\n💵 Anticipo: $${anticipo}\n💸 Total gastos: $${total.toFixed(2)}\n🔴 *Diferencia: -$${Math.abs(diferencia).toFixed(2)}*\n\nEl operador gastó más de lo anticipado.`;
        bot.sendMessage(ADMIN_ID, alerta, { parse_mode: 'Markdown' });
      }
    }
    return;
  }

  // ── Diésel ──
  if (estado === 'diesel') {
    const paso = userState[chatId].paso;
    const campo = PREGUNTAS_DIESEL[paso].campo;
    userState[chatId].datos[campo] = msg.text.trim();
    const sig = paso + 1;
    if (sig < PREGUNTAS_DIESEL.length) {
      userState[chatId].paso = sig;
      bot.sendMessage(chatId, PREGUNTAS_DIESEL[sig].pregunta);
    } else {
      const d = userState[chatId].datos;
      userState[chatId] = { estado: null };
      const fecha = new Date().toLocaleDateString('es-MX');
      const difKm = parsearNumero(d.km_nuevo) - parsearNumero(d.km_ant);
      const litros = parsearNumero(d.litros);
      const rend = difKm > 0 && litros > 0 ? (difKm / litros).toFixed(3) : 0;
      try {
        await appendRow(SHEET_DIESEL, `ECO #${d.tracto}`, [fecha, d.vale, d.tracto, d.km_nuevo, d.km_ant, difKm, litros, rend, '']);
      } catch (e) {
        await appendRow(SHEET_DIESEL, 'ACUMULADO', [fecha, d.vale, d.tracto, d.km_nuevo, d.km_ant, difKm, litros, rend, '']);
      }
      bot.sendMessage(chatId, `⛽ *Diésel registrado*\n\n👤 ${d.operador} - Tracto #${d.tracto}\n📅 ${fecha}\n📏 Km recorridos: ${difKm}\n💧 Litros: ${litros}\n📊 Rendimiento: ${rend} km/lt\n🔢 Vale: ${d.vale}`, { parse_mode: 'Markdown' });
    }
    return;
  }

  // ── Sello ──
  if (estado === 'sello') {
    const paso = userState[chatId].paso;
    const campo = PREGUNTAS_SELLO[paso].campo;
    userState[chatId].datos[campo] = msg.text.trim();
    const sig = paso + 1;
    if (sig < PREGUNTAS_SELLO.length) {
      userState[chatId].paso = sig;
      bot.sendMessage(chatId, PREGUNTAS_SELLO[sig].pregunta);
    } else {
      const ops = await getOperadores();
      const operador = ops[String(chatId)];
      const d = userState[chatId].datos;
      userState[chatId] = { estado: null };
      const fecha = new Date().toLocaleDateString('es-MX');
      await appendRow(SHEET_BOT, 'Sellos', [fecha, operador.nombre, operador.tracto, d.num_sello, d.cliente, d.destino, d.caja]);
      const resumen = `🔒 *Sello registrado*\n\n👤 ${operador.nombre} - Tracto #${operador.tracto}\n📅 ${fecha}\n🔢 Sello: ${d.num_sello}\n🏭 Cliente: ${d.cliente}\n📍 Destino: ${d.destino}\n📦 Caja: ${d.caja}`;
      bot.sendMessage(chatId, resumen, { parse_mode: 'Markdown' });
      if (ADMIN_ID) bot.sendMessage(ADMIN_ID, resumen, { parse_mode: 'Markdown' });
    }
    return;
  }
});

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Para reportar gastos usa /gastos\nPara un sello usa /sello');
});

iniciarBot();
