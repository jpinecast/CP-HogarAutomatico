import dotenv from "dotenv";
import imap from "imap-simple";
import { simpleParser } from "mailparser";
import fetch from "node-fetch";
import { chromium } from "playwright"; // Cambiado a Playwright

dotenv.config();

const imapConfig = {
  imap: {
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASSWORD,
    host: process.env.IMAP_HOST,
    port: process.env.IMAP_PORT,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  },
};

// Playwright navegador
let browser = null;

async function startMonitoring() {
  try {
    console.log("Conectando al servidor IMAP...");
    const connection = await imap.connect(imapConfig);
    await connection.openBox("INBOX");
    console.log("Conexión establecida y monitoreando correos.");

    // Inicia Playwright
    browser = await chromium.launch({ headless: true });

    // Verificar número de correos y eliminar si exceden el límite
    await checkAndCleanInbox(connection);

    connection.on("mail", async () => {
      console.log("Nuevo correo detectado. Procesando...");
      const searchCriteria = ["UNSEEN"];
      const fetchOptions = { bodies: ["HEADER", "TEXT"], markSeen: true };

      try {
        console.log("Buscando correos no leídos...");
        const messages = await connection.search(searchCriteria, fetchOptions);
        console.log(`Número de correos encontrados: ${messages.length}`);

        for (const [index, message] of messages.entries()) {
          console.log(`Procesando correo #${index + 1}`);

          const headers = message.parts.find(part => part.which === "HEADER");
          const body = message.parts.find(part => part.which === "TEXT");
          if (!headers) {
            console.log("No se encontraron encabezados en el correo. Ignorando.");
            continue;
          }

          const parsed = await simpleParser(body.body);
          const subject = headers.body.subject || parsed.subject;

          console.log("Asunto del correo:", subject);

          if (subject && subject.includes("Importante: Cómo actualizar tu Hogar con Netflix")) {
            console.log("Correo relacionado con Netflix detectado.");
            const authorizationLink = extractNetflixLink(parsed.html || parsed.text);

            if (authorizationLink) {
              console.log(`Enlace de autorización encontrado: ${authorizationLink}`);
              await approveHomeUpdate(authorizationLink);
            } else {
              console.log("No se encontró un enlace de aprobación en el correo.");
            }
          } else {
            console.log("El correo no coincide con el asunto esperado. Ignorando.");
          }
        }
      } catch (err) {
        console.error("Error al buscar correos:", err);
      }

      // Verificar número de correos después de procesar
      await checkAndCleanInbox(connection);
    });

    connection.on("error", async (error) => {
      console.error("Error en la conexión IMAP:", error);
      console.log("Intentando reconectar...");
      reconnect();
    });

    connection.on("end", async () => {
      console.log("Conexión IMAP finalizada. Intentando reconectar...");
      reconnect();
    });
  } catch (error) {
    console.error("Error en el monitoreo de correos:", error);
    console.log("Intentando reconectar en 5 segundos...");
    setTimeout(startMonitoring, 5000);
  }
}

function extractNetflixLink(content) {
  console.log("Extrayendo enlaces del correo...");
  const regex = /https?:\/\/www\.netflix\.com\/[^\s]+/g;
  const links = content.match(regex);

  if (links) {
    const authorizationLink = links.find(link =>
      link.startsWith("https://www.netflix.com/account/update-primary-location?")
    );
    return authorizationLink || null;
  }
  return null;
}

async function approveHomeUpdate(link) {
  console.log("Intentando aprobar la actualización de hogar...");
  try {
    const response = await fetch(link, { method: "GET" });
    if (response.ok) {
      console.log("Se abrió el enlace inicial correctamente.");
    } else {
      console.error("Error al abrir el enlace inicial:", response.statusText);
      return;
    }

    console.log("Navegando para confirmar la actualización...");
    await confirmHomeUpdate(link);
  } catch (error) {
    console.error("Error al realizar la solicitud de aprobación:", error);
  }
}

async function confirmHomeUpdate(link) {
  console.log("Iniciando navegador para confirmar la actualización...");
  const browser = await chromium.launch({ headless: true }); // Cambiado a Playwright
  const page = await browser.newPage();

  try {
    await page.goto(link, { waitUntil: "networkidle" });
    console.log("Página cargada. Verificando contenido...");

    const iframe = await page.frame({ name: "iframe" }); // Detectar iframe
    const frame = iframe || page;

    console.log("Buscando botón de confirmación...");
    const buttonSelector = 'button[data-uia="set-primary-location-action"]';
    await frame.waitForSelector(buttonSelector, { timeout: 60000 });
    console.log("Botón encontrado. Haciendo clic...");
    await frame.click(buttonSelector);

    console.log("Esperando mensaje de confirmación...");
    await page.waitForSelector('div:has-text("Actualizaste tu Hogar con Netflix")', { timeout: 60000 });
    console.log("Confirmación completada.");

    await browser.close();
  } catch (error) {
    console.error("Error al confirmar la actualización:", error);
    await browser.close();
  }
}

async function checkAndCleanInbox(connection) {
  console.log("Verificando la cantidad de correos en la bandeja de entrada...");
  try {
    const messages = await connection.search(["ALL"], { bodies: ["HEADER"], markSeen: false });
    const totalMessages = messages.length;
    console.log(`Número total de correos en la bandeja de entrada: ${totalMessages}`);

    if (totalMessages > 1000) {
      console.log(`La bandeja de entrada supera el límite de 1000 correos. Eliminando correos antiguos...`);
      const messageUids = messages.map(msg => msg.attributes.uid);
      const uidsToDelete = messageUids.slice(0, totalMessages - 1000);

      if (uidsToDelete.length > 0) {
        await connection.addFlags(uidsToDelete, "\\Deleted");
        await connection.imap.expunge();
        console.log(`Se eliminaron ${uidsToDelete.length} correos antiguos.`);
      }
    } else {
      console.log("La bandeja de entrada está dentro del límite permitido.");
    }
  } catch (error) {
    console.error("Error al verificar o limpiar la bandeja de entrada:", error);
  }
}

async function reconnect() {
  console.log("Reconectando...");
  setTimeout(startMonitoring, 5000);
}

startMonitoring();
