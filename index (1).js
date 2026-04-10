const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { google } = require('googleapis');

const TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const SHEET_ID = '1QL7OvJYnAYxTXcD23sD51oUAbuNUs8-gpbVWkBY3CCk';

const bot = new TelegramBot(TOKEN, { polling: true });
const userState = {};

// ─── Google Sheets ───────────────────────────────────────────────────────────
function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function appendRow(sheet, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!A1`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] },
  });
}

async function getRows(sheet) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!A1:Z1000`,
  });
  return res.data.values || [];
}

async function clearAndWrite(sheet, rows) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!A1:Z1000`,
  });
  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sheet}!A1`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows },
    });
  }
}

// ─── Operadores (guardados en Sheets) ────────────────────────────────────────
async function getOperadores() {
  const rows = await getRows('Operadores');
  const ops = {};
  rows.forEach(r => {
    if (r[0] && r[0] !== 'chatId') {
      ops[r[0]] = { chatId: r[0], nombre: r[1], tracto: r[2] };
    }
  });
  return ops;
}

async function saveOperador(chatId, nombre, tracto) {
  const rows = await getRows('Operadores');
  if (rows.length === 0) {
    await appendRow('Operadores', ['chatId', 'nombre', 'tracto']);
  }
  // Actualizar si ya existe
  const existing = rows.findIndex(r => r[0] === String(chatId));
  if (existing >= 0) {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Operadores!A${existing + 1}:C${existing + 1}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[String(chatId), nombre, tracto]] },
    });
  } else {
    await appendRow('Operadores', [String(chatId), nombre, tracto]);
  }
}

// ─── Viajes (guardados en Sheets) ────────────────────────────────────────────
async function getViajes() {
  const rows = await getRows('Viajes');
  if (rows.length <= 1) return [];
  return rows.slice(1).map((r, i) => ({
    idx: i + 1,
    fecha: r[0], cliente: r[1], destino: r[2],
    hora: r[3], operador: r[4] || 'Sin asignar',
  }));
}

async function saveViaje(viaje) {
  const rows = await getRows('Viajes');
  if (rows.length === 0) {
    await appendRow('Viajes', ['fecha', 'cliente', 'destino', 'hora', 'operador']);
  }
  await appendRow('Viajes', [viaje.fecha, viaje.cliente, viaje.destino, viaje.hora, viaje.operador || '']);
}

async function asignarOperadorViaje(idx, nombreOperador) {
  const rows = await getRows('Viajes');
  const rowNum = idx + 1; // +1 por encabezado, +1 por base 1
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Viajes!E${rowNum + 1}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[nombreOperador]] },
  });
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
async function procesarFotoConGemini(imageBuffer, tipo) {
  const base64 = imageBuffer.toString('base64');
  let prompt = '';
  if (tipo === 'kilometraje') {
    prompt = 'Foto del odómetro de un camión. Extrae el número de kilómetros. Responde SOLO en JSON: {"kilometraje": 123456}';
  } else if (tipo === 'ticket') {
    prompt = 'Foto de ticket de diésel. Extrae: número de vale, litros, costo por litro, total, fecha. Responde SOLO en JSON: {"vale": "123", "litros": 300, "costo_litro": 27.5, "total": 8250, "fecha": "2026-04-10"}';
  } else if (tipo === 'vale') {
    prompt = 'Foto de un vale o remisión. Extrae el número de vale. Responde SOLO en JSON: {"numero_vale": "172122"}';
  } else if (tipo === 'gastos') {
    prompt = 'Foto de comprobantes de gastos de operador de camión. Extrae conceptos y montos. Responde SOLO en JSON: {"gastos": [{"concepto": "comida", "monto": 150}], "total": 350}';
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: base64 } }, { text: prompt }] }]
  };
  const response = await axios.post(url, body);
  const text = response.data.candidates[0].content.parts[0].text;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { raw: text };
  } catch { return { raw: text }; }
}

async function descargarFoto(fileId) {
  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

// ─── Comandos ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const isAdmin = String(chatId) === String(ADMIN_ID);
  if (isAdmin) {
    bot.sendMessage(chatId,
      `👋 *Bienvenido Admin!*\n\n📋 Comandos:\n\n/nuevos_viajes - Registrar viajes\n/ver_viajes - Ver viajes\n/operadores - Ver operadores\n/resumen - Resumen de gastos`,
      { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId,
      `👋 Bienvenido al Bot de Logística 🚛\n\nPara registrarte:\n/registrar NOMBRE TRACTO\n\nEjemplo:\n/registrar Rafael 9`);
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
    bot.sendMessage(chatId, `✅ Registrado como *${nombre}* - Tracto #${tracto}`, { parse_mode: 'Markdown' });
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
  let lista = '🚛 *Operadores registrados:*\n\n';
  Object.values(ops).forEach(op => { lista += `• ${op.nombre} - Tracto #${op.tracto}\n`; });
  bot.sendMessage(chatId, lista, { parse_mode: 'Markdown' });
});

bot.onText(/\/nuevos_viajes/, (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  userState[chatId] = { estado: 'esperando_viajes' };
  bot.sendMessage(chatId,
    `📋 *Viajes de la semana*\n\nEnvía uno por línea:\nFECHA | CLIENTE | DESTINO | HORA\n\nEjemplo:\nLunes 13 | Conagra | Local | 4:30pm\nMartes 14 | Pulses GDL | Irap-GDL | Sin cita\n\nEscribe *fin* cuando termines`,
    { parse_mode: 'Markdown' });
});

bot.onText(/\/ver_viajes/, async (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  const viajes = await getViajes();
  if (viajes.length === 0) return bot.sendMessage(chatId, '❌ No hay viajes registrados.');
  let lista = '📋 *Viajes de la semana:*\n\n';
  viajes.forEach(v => {
    lista += `${v.idx}. ${v.fecha} | ${v.cliente} | ${v.destino} | ${v.hora} | 👤 ${v.operador}\n`;
  });
  lista += `\n/asignar NUMERO NOMBRE\nEjemplo: /asignar 1 Rafael`;
  bot.sendMessage(chatId, lista, { parse_mode: 'Markdown' });
});

bot.onText(/\/asignar (\d+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  const idx = parseInt(match[1]);
  const nombreOperador = match[2].trim();
  const viajes = await getViajes();
  const viaje = viajes.find(v => v.idx === idx);
  if (!viaje) return bot.sendMessage(chatId, '❌ Número de viaje incorrecto.');
  await asignarOperadorViaje(idx, nombreOperador);
  const ops = await getOperadores();
  const entry = Object.values(ops).find(op => op.nombre.toLowerCase() === nombreOperador.toLowerCase());
  if (entry) {
    bot.sendMessage(entry.chatId,
      `🚛 *Nuevo viaje asignado:*\n\n📅 ${viaje.fecha}\n🏭 ${viaje.cliente}\n📍 ${viaje.destino}\n🕐 ${viaje.hora}\n\nResponde con /confirmar`,
      { parse_mode: 'Markdown' });
    bot.sendMessage(chatId, `✅ Asignado a *${nombreOperador}* y notificado.`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `⚠️ Viaje asignado pero *${nombreOperador}* no está registrado aún.`, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/confirmar/, async (msg) => {
  const chatId = msg.chat.id;
  const ops = await getOperadores();
  const operador = ops[String(chatId)];
  if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado. Usa /registrar NOMBRE TRACTO');
  userState[chatId] = { estado: 'esperando_remision' };
  bot.sendMessage(chatId, `✅ Viaje confirmado!\n\nEnvíame el *número de remisión* y *número de caja*\n\nEjemplo: Remisión 12345, Caja 67`, { parse_mode: 'Markdown' });
});

bot.onText(/\/diesel/, async (msg) => {
  const chatId = msg.chat.id;
  const ops = await getOperadores();
  const operador = ops[String(chatId)];
  if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado. Usa /registrar NOMBRE TRACTO');
  userState[chatId] = { estado: 'esperando_km', diesel: {} };
  bot.sendMessage(chatId, `⛽ *Reporte de Diésel*\n\nPaso 1 de 3: Envía 📸 foto del *kilometraje*`, { parse_mode: 'Markdown' });
});

bot.onText(/\/gastos/, async (msg) => {
  const chatId = msg.chat.id;
  const ops = await getOperadores();
  const operador = ops[String(chatId)];
  if (!operador) return bot.sendMessage(chatId, '❌ No estás registrado. Usa /registrar NOMBRE TRACTO');
  userState[chatId] = { estado: 'esperando_foto_gastos' };
  bot.sendMessage(chatId, `💰 *Gastos*\n\nEnvía 📸 foto de tus comprobantes:`, { parse_mode: 'Markdown' });
});

bot.onText(/\/resumen/, async (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== String(ADMIN_ID)) return;
  try {
    const diesel = await getRows('Diesel');
    const gastos = await getRows('Gastos');
    let txt = `📊 *Resumen*\n\n⛽ Reportes de diésel: ${Math.max(0, diesel.length - 1)}\n💰 Reportes de gastos: ${Math.max(0, gastos.length - 1)}`;
    bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(chatId, '❌ Error al obtener resumen.');
  }
});

// ─── Mensajes de texto ────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const estado = userState[chatId]?.estado;
  if (!msg.text || msg.text.startsWith('/')) return;

  if (estado === 'esperando_viajes') {
    if (msg.text.toLowerCase() === 'fin') {
      userState[chatId] = { estado: null };
      const viajes = await getViajes();
      if (viajes.length === 0) return bot.sendMessage(chatId, '❌ No hay viajes.');
      let lista = `✅ *Viajes registrados:*\n\n`;
      viajes.forEach(v => { lista += `${v.idx}. ${v.fecha} | ${v.cliente} | ${v.destino} | ${v.hora}\n`; });
      lista += `\n/asignar NUMERO NOMBRE`;
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

  if (estado === 'esperando_remision') {
    const ops = await getOperadores();
    const operador = ops[String(chatId)];
    userState[chatId] = { estado: null };
    const fecha = new Date().toLocaleDateString('es-MX');
    await appendRow('Remisiones', [fecha, operador.nombre, operador.tracto, msg.text]);
    if (ADMIN_ID) bot.sendMessage(ADMIN_ID, `📦 *${operador.nombre}* - Tracto #${operador.tracto}\n\n${msg.text}`, { parse_mode: 'Markdown' });
    bot.sendMessage(chatId, '✅ Datos enviados. ¡Buen viaje! 🚛');
  }
});

// ─── Fotos ────────────────────────────────────────────────────────────────────
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const estado = userState[chatId]?.estado;
  const ops = await getOperadores();
  const operador = ops[String(chatId)];
  if (!operador && String(chatId) !== String(ADMIN_ID)) return bot.sendMessage(chatId, '❌ No estás registrado. Usa /registrar NOMBRE TRACTO');
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  try {
    if (estado === 'esperando_km') {
      await bot.sendMessage(chatId, '⏳ Leyendo kilometraje...');
      const buffer = await descargarFoto(fileId);
      const datos = await procesarFotoConGemini(buffer, 'kilometraje');
      userState[chatId] = { estado: 'esperando_ticket', diesel: { kilometraje: datos.kilometraje || 'ver foto' } };
      bot.sendMessage(chatId, `✅ Km: *${datos.kilometraje || 'continúa'}*\n\nPaso 2 de 3: Envía 📸 foto del *ticket de diésel*`, { parse_mode: 'Markdown' });
      return;
    }

    if (estado === 'esperando_ticket') {
      await bot.sendMessage(chatId, '⏳ Leyendo ticket...');
      const buffer = await descargarFoto(fileId);
      const datos = await procesarFotoConGemini(buffer, 'ticket');
      userState[chatId].estado = 'esperando_vale';
      userState[chatId].diesel.ticket = datos;
      bot.sendMessage(chatId, `✅ Ticket leído!\n\nPaso 3 de 3: Envía 📸 foto del *vale*`, { parse_mode: 'Markdown' });
      return;
    }

    if (estado === 'esperando_vale') {
      await bot.sendMessage(chatId, '⏳ Leyendo vale...');
      const buffer = await descargarFoto(fileId);
      const datos = await procesarFotoConGemini(buffer, 'vale');
      const diesel = userState[chatId].diesel;
      diesel.vale = datos.numero_vale || 'ver foto';
      userState[chatId] = { estado: null };
      const fecha = new Date().toLocaleDateString('es-MX');
      await appendRow('Diesel', [
        fecha, operador.nombre, operador.tracto,
        diesel.kilometraje, diesel.vale,
        diesel.ticket?.litros || '', diesel.ticket?.total || ''
      ]);
      const resumen = `⛽ *Reporte de Diésel*\n\n👤 ${operador.nombre}\n🚛 Tracto #${operador.tracto}\n📅 ${fecha}\n📏 Km: ${diesel.kilometraje}\n🔢 Vale: ${diesel.vale}\n💧 Litros: ${diesel.ticket?.litros || 'N/A'}\n💰 Total: $${diesel.ticket?.total || 'N/A'}`;
      bot.sendMessage(chatId, resumen + '\n\n✅ Guardado y enviado al administrador.', { parse_mode: 'Markdown' });
      if (ADMIN_ID) bot.sendMessage(ADMIN_ID, resumen, { parse_mode: 'Markdown' });
      return;
    }

    if (estado === 'esperando_foto_gastos') {
      await bot.sendMessage(chatId, '⏳ Leyendo comprobantes...');
      const buffer = await descargarFoto(fileId);
      const datos = await procesarFotoConGemini(buffer, 'gastos');
      userState[chatId] = { estado: null };
      const fecha = new Date().toLocaleDateString('es-MX');
      let conceptos = '';
      let total = datos.total || 0;
      if (datos.gastos && Array.isArray(datos.gastos)) {
        conceptos = datos.gastos.map(g => `${g.concepto}:$${g.monto}`).join(', ');
      }
      await appendRow('Gastos', [fecha, operador.nombre, operador.tracto, conceptos, total]);
      let resumen = `💰 *Gastos*\n\n👤 ${operador.nombre} - Tracto #${operador.tracto}\n📅 ${fecha}\n\n`;
      if (datos.gastos && Array.isArray(datos.gastos)) {
        datos.gastos.forEach(g => { resumen += `• ${g.concepto}: $${g.monto}\n`; });
        resumen += `\n*Total: $${datos.total || 'N/A'}*`;
      } else { resumen += datos.raw || 'Ver foto'; }
      bot.sendMessage(chatId, '✅ Gastos guardados y enviados al administrador.', { parse_mode: 'Markdown' });
      if (ADMIN_ID) bot.sendMessage(ADMIN_ID, resumen, { parse_mode: 'Markdown' });
      return;
    }

  } catch (error) {
    console.error('Error:', error);
    bot.sendMessage(chatId, '❌ Error procesando foto. Intenta de nuevo.');
  }
});

console.log('🚛 Bot Transportes Regis iniciado...');
