import qrCode from "qrcode-terminal";
import { Client, LocalAuth } from "whatsapp-web.js";
import { getIO } from "./socket";
import Whatsapp from "../models/Whatsapp";
import AppError from "../errors/AppError";
import { logger } from "../utils/logger";
import { handleMessage } from "../services/WbotServices/wbotMessageListener";

interface Session extends Client {
  id?: number;
}

const sessions: Session[] = [];
const MAX_RETRIES = 5;
const RECONNECT_INTERVAL = 5000; // 5 segundos

const destroyClient = async (wbot: Session) => {
  try {
    await wbot.destroy();
  } catch (error) {
    logger.error("Error destroying client:", error);
  }
};

const initializeWithRetry = async (wbot: Session, whatsapp: Whatsapp, retries = 0): Promise<void> => {
  try {
    await wbot.initialize();
  } catch (error) {
    if (retries < MAX_RETRIES) {
      logger.warn(`Initialization attempt ${retries + 1} failed. Retrying in ${RECONNECT_INTERVAL/1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, RECONNECT_INTERVAL));
      return initializeWithRetry(wbot, whatsapp, retries + 1);
    }
    throw error;
  }
};

const syncUnreadMessages = async (wbot: Session) => {
  const chats = await wbot.getChats();

  /* eslint-disable no-restricted-syntax */
  /* eslint-disable no-await-in-loop */
  for (const chat of chats) {
    if (chat.unreadCount > 0) {
      const unreadMessages = await chat.fetchMessages({
        limit: chat.unreadCount
      });

      for (const msg of unreadMessages) {
        await handleMessage(msg, wbot);
      }

      await chat.sendSeen();
    }
  }
};

export const initWbot = async (whatsapp: Whatsapp): Promise<Session> => {
  return new Promise((resolve, reject) => {
    try {
      const io = getIO();
      const sessionName = whatsapp.name;
      let sessionCfg;

      if (whatsapp && whatsapp.session) {
        sessionCfg = JSON.parse(whatsapp.session);
      }

      const args: String = process.env.CHROME_ARGS || "";

      const wbot: Session = new Client({
        session: sessionCfg,
        authStrategy: new LocalAuth({ clientId: 'bd_' + whatsapp.id }),
        puppeteer: {
          executablePath: process.env.CHROME_BIN || undefined,
          // @ts-ignore
          browserWSEndpoint: process.env.CHROME_WS || undefined,
          args: args.split(' ')
        },
        restartOnAuthFail: true,
        webVersionCache: {
          type: 'local',
          path: './.wwebjs_cache'
        }
      });

      const reconnect = async () => {
        try {
          logger.info(`Attempting to reconnect session: ${sessionName}`);
          await destroyClient(wbot);
          await initializeWithRetry(wbot, whatsapp);
        } catch (error) {
          logger.error("Reconnection failed:", error);
          await whatsapp.update({
            status: "DISCONNECTED",
            qrcode: ""
          });

          io.emit("whatsappSession", {
            action: "update",
            session: whatsapp
          });
        }
      };

      wbot.on("qr", async qr => {
        logger.info("Session:", sessionName);
        qrCode.generate(qr, { small: true });
        await whatsapp.update({ qrcode: qr, status: "qrcode", retries: 0 });

        const sessionIndex = sessions.findIndex(s => s.id === whatsapp.id);
        if (sessionIndex === -1) {
          wbot.id = whatsapp.id;
          sessions.push(wbot);
        }

        io.emit("whatsappSession", {
          action: "update",
          session: whatsapp
        });
      });

      wbot.on("authenticated", async session => {
        logger.info(`Session: ${sessionName} AUTHENTICATED`);
      });

      wbot.on("auth_failure", async msg => {
        logger.error(
          `Session: ${sessionName} AUTHENTICATION FAILURE! Reason: ${msg}`
        );

        if (whatsapp.retries > 1) {
          await whatsapp.update({ session: "", retries: 0 });
        }

        const retry = whatsapp.retries;
        await whatsapp.update({
          status: "DISCONNECTED",
          retries: retry + 1
        });

        io.emit("whatsappSession", {
          action: "update",
          session: whatsapp
        });

        setTimeout(reconnect, RECONNECT_INTERVAL);
      });

      wbot.on("disconnected", async (reason) => {
        logger.warn(`Session: ${sessionName} DISCONNECTED. Reason: ${reason}`);

        await whatsapp.update({
          status: "DISCONNECTED",
          qrcode: ""
        });

        io.emit("whatsappSession", {
          action: "update",
          session: whatsapp
        });

        setTimeout(reconnect, RECONNECT_INTERVAL);
      });

      wbot.on("ready", async () => {
        logger.info(`Session: ${sessionName} READY`);

        await whatsapp.update({
          status: "CONNECTED",
          qrcode: "",
          retries: 0
        });

        io.emit("whatsappSession", {
          action: "update",
          session: whatsapp
        });

        const sessionIndex = sessions.findIndex(s => s.id === whatsapp.id);
        if (sessionIndex === -1) {
          wbot.id = whatsapp.id;
          sessions.push(wbot);
        }

        wbot.sendPresenceAvailable();
        await syncUnreadMessages(wbot);

        resolve(wbot);
      });

      initializeWithRetry(wbot, whatsapp).catch(error => {
        logger.error("Initialization failed:", error);
        reject(error);
      });

    } catch (err) {
      logger.error(err);
      reject(err);
    }
  });
};

export const getWbot = (whatsappId: number): Session => {
  const sessionIndex = sessions.findIndex(s => s.id === whatsappId);

  if (sessionIndex === -1) {
    throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  }
  return sessions[sessionIndex];
};

export const removeWbot = async (whatsappId: number): Promise<void> => {
  try {
    const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
    if (sessionIndex !== -1) {
      await destroyClient(sessions[sessionIndex]);
      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(err);
  }
};