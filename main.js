const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const WebSocket = require('ws');
const RPC = require('discord-rpc');
const { execSync } = require('child_process');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

// Bypass self-signed certificate rejections on restricted networks
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let mainWindow;
let logConsoleWindow = null;
const launcher = new Client();
const authManager = new Auth("select_account");

// --- DISCORD RICH PRESENCE SETUP ---
const DISCORD_CLIENT_ID = '1543527706875138108';
let rpc = null;

function initDiscordRPC() {
  rpc = new RPC.Client({ transport: 'ipc' });

  rpc.on('ready', () => {
    console.log('[Discord RPC] Rich Presence connected successfully!');
    setLauncherActivity('In Launcher', 'Browsing Mods & Profiles');
  });

  rpc.login({ clientId: DISCORD_CLIENT_ID }).catch(err => {
    console.error('[Discord RPC Error]:', err.message);
  });
}

function setLauncherActivity(details, state) {
  if (!rpc) return;
  try {
    rpc.setActivity({
      details: details,
      state: state,
      startTimestamp: Date.now(),
      largeImageKey: 'logo',
      largeImageText: 'TuxClient Launcher',
      instance: false,
    }, process.pid); // Binding process.pid prevents Discord from auto-idling
  } catch (err) {
    console.error('[Discord RPC Activity Error]:', err.message);
  }
}

// Tracks current user identity for socket authentication and logout broadcast
let currentActiveUsername = null;

// --- LOGGING & AUTO-UPDATER CONFIGURATION ---
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = false; // Do not download silently so we can prompt the user via renderer modal
autoUpdater.autoInstallOnAppQuit = true;

// --- RENDER BACKEND WEBSOCKET URL ---
const SERVER_WS_URL = "wss://tuxclient-backend.onrender.com";
const TUX_ROOT = path.join(app.getPath('appData'), '.tuxclient');

// --- AUTO-UPDATER EVENTS ---
autoUpdater.on('checking-for-update', () => {
  console.log('[AutoUpdater] Checking for updates...');
  sendConsoleLog('info', '[AutoUpdater] Checking for available client updates...');
});

autoUpdater.on('update-available', (info) => {
  console.log('[AutoUpdater] Update available:', info.version);
  sendConsoleLog('info', `[AutoUpdater] Update available: v${info.version}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-available-prompt', info.version);
  }
});

autoUpdater.on('update-not-available', () => {
  console.log('[AutoUpdater] App is up to date.');
  sendConsoleLog('info', '[AutoUpdater] TuxClient Launcher is fully up to date.');
});

autoUpdater.on('download-progress', (progressObj) => {
  const percent = Math.floor(progressObj.percent);
  console.log(`[AutoUpdater] Download Progress: ${percent}%`);
  sendConsoleLog('info', `[AutoUpdater Download] ${percent}% completed`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-progress', percent);
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[AutoUpdater] Update downloaded completely.');
  sendConsoleLog('info', '[AutoUpdater] Update package downloaded successfully. Ready for installation.');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-ready-prompt');
  }
});

autoUpdater.on('error', (err) => {
  console.error('[AutoUpdater Error]:', err);
  sendConsoleLog('error', `[AutoUpdater Error] ${err.message || err}`);
});

ipcMain.on('check-for-updates', () => {
  if (app.isPackaged) {
    autoUpdater.checkForUpdates();
  } else {
    sendConsoleLog('info', '[AutoUpdater] Skipping check (Development Environment detected)');
  }
});

ipcMain.on('start-download-update', () => {
  console.log('[AutoUpdater] User accepted update. Starting download...');
  sendConsoleLog('info', '[AutoUpdater] User accepted update. Starting background download...');
  autoUpdater.downloadUpdate();
});

ipcMain.on('install-update-now', () => {
  console.log('[AutoUpdater] Restarting application to apply update...');
  autoUpdater.quitAndInstall();
});

// --- TUXCLIENT THEMED CONSOLE LOG WINDOW ---
function createTuxConsoleWindow() {
  if (logConsoleWindow && !logConsoleWindow.isDestroyed()) {
    logConsoleWindow.focus();
    return;
  }

  logConsoleWindow = new BrowserWindow({
    title: "TuxClient Console Logs",
    width: 820,
    height: 500,
    backgroundColor: '#0D0D11',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>TuxClient Console</title>
      <style>
        body {
          background-color: #0D0D11;
          color: #E2E8F0;
          font-family: 'Consolas', 'Courier New', monospace;
          margin: 0;
          padding: 16px;
          box-sizing: border-box;
          overflow-x: hidden;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 12px;
          border-bottom: 1px solid #1E1E2A;
          margin-bottom: 12px;
        }
        .title {
          font-size: 13px;
          font-weight: bold;
          color: #A855F7;
          letter-spacing: 1px;
        }
        #console-output {
          font-size: 12px;
          line-height: 1.5;
          white-space: pre-wrap;
          word-break: break-all;
        }
        .log-line { margin-bottom: 4px; }
        .log-info { color: #94A3B8; }
        .log-mc { color: #38BDF8; }
        .log-debug { color: #A855F7; }
        .log-error { color: #EF4444; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="title">TUXCLIENT // LIVE LAUNCH LOGS</div>
      </div>
      <div id="console-output">
        <div class="log-line log-info">[TuxConsole] Live console output initialized...</div>
      </div>
      <script>
        const { ipcRenderer } = require('electron');
        const output = document.getElementById('console-output');

        ipcRenderer.on('console-append', (event, { type, message }) => {
          const line = document.createElement('div');
          line.className = 'log-line log-' + type;
          line.innerText = message;
          output.appendChild(line);
          window.scrollTo(0, document.body.scrollHeight);
        });
      </script>
    </body>
    </html>
  `;

  logConsoleWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
}

function sendConsoleLog(type, message) {
  if (logConsoleWindow && !logConsoleWindow.isDestroyed()) {
    logConsoleWindow.webContents.send('console-append', { type, message });
  }
}

/**
 * Validates file integrity across libraries, assets, and versions.
 * Checks for 0-byte files, invalid/empty JSON, and corrupt JARs (ZIP header check).
 */
function sanitizeAndValidateInstanceFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      sanitizeAndValidateInstanceFiles(fullPath);
    } else if (entry.isFile()) {
      try {
        const stats = fs.statSync(fullPath);

        // 1. Check for 0-byte empty files
        if (stats.size === 0) {
          console.warn(`[TuxFix] Deleting 0-byte corrupted file: ${fullPath}`);
          fs.unlinkSync(fullPath);
          continue;
        }

        // 2. Validate JSON file structural integrity
        if (entry.name.endsWith('.json')) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            JSON.parse(content);
          } catch (jsonErr) {
            console.warn(`[TuxFix] Deleting malformed JSON file: ${fullPath}`);
            fs.unlinkSync(fullPath);
            continue;
          }
        }

        // 3. Validate JAR archive integrity (Check for 'PK' ZIP signature bytes)
        if (entry.name.endsWith('.jar')) {
          const buffer = Buffer.alloc(4);
          const fd = fs.openSync(fullPath, 'r');
          fs.readSync(fd, buffer, 0, 4, 0);
          fs.closeSync(fd);

          // ZIP header signature: 0x50 0x4B 0x03 0x04 ("PK\x03\x04")
          if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
            console.warn(`[TuxFix] Deleting corrupted JAR archive (bad header): ${fullPath}`);
            fs.unlinkSync(fullPath);
            continue;
          }
        }
      } catch (err) {
        console.error(`[TuxFix] Error inspecting ${fullPath}, removing:`, err);
        try { fs.unlinkSync(fullPath); } catch (e) {}
      }
    }
  }
}

// --- DYNAMIC VERSION-AWARE JAVA FINDER AND DOWNLOADER ---
function findJavaExecutable(dir, targetExe = 'java.exe') {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const found = findJavaExecutable(fullPath, targetExe);
      if (found) return found;
    } else if (file.toLowerCase() === targetExe.toLowerCase()) {
      return fullPath;
    }
  }
  return null;
}

async function ensurePortableJava(event, requiredMajorVersion = 21) {
  const javaDir = path.join(TUX_ROOT, 'assets', `java-${requiredMajorVersion}`);

  let javaPath = findJavaExecutable(javaDir, 'java.exe');
  if (javaPath) return javaPath;

  sendConsoleLog('info', `[TuxJava] Downloading Portable JRE ${requiredMajorVersion}...`);
  if (mainWindow) mainWindow.webContents.send('launch-status', `Downloading Java ${requiredMajorVersion} Runtime...`);
  fs.mkdirSync(javaDir, { recursive: true });

  const zipPath = path.join(javaDir, `jre${requiredMajorVersion}.zip`);
  
  const javaUrl = requiredMajorVersion >= 25
    ? "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25%2B36/OpenJDK25U-jre_x64_windows_hotspot_25_36.zip"
    : "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.2%2B13/OpenJDK21U-jre_x64_windows_hotspot_21.0.2_13.zip";

  const response = await axios({ url: javaUrl, method: 'GET', responseType: 'stream' });
  const writer = fs.createWriteStream(zipPath);
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  sendConsoleLog('info', `[TuxJava] Extracting Java ${requiredMajorVersion} Runtime via PowerShell...`);
  if (mainWindow) mainWindow.webContents.send('launch-status', `Extracting Java ${requiredMajorVersion}...`);

  execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${javaDir}' -Force"`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  javaPath = findJavaExecutable(javaDir, 'java.exe');
  if (!javaPath) {
    throw new Error(`Failed to locate java.exe after extracting Java ${requiredMajorVersion}.`);
  }

  sendConsoleLog('info', `[TuxJava] Portable Java ${requiredMajorVersion} ready at: ${javaPath}`);
  return javaPath;
}

// --- GAME DIRECTORY & BUNDLED MOD INJECTION HELPER ---
function ensureBundledMods(modsDir, mcVersion) {
  const sourceBundledDir = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'client-mods')
    : path.join(__dirname, 'assets', 'client-mods');

  if (fs.existsSync(sourceBundledDir)) {
    const bundledFiles = fs.readdirSync(sourceBundledDir);
    bundledFiles.forEach(file => {
      if (file.endsWith('.jar')) {
        const sourcePath = path.join(sourceBundledDir, file);
        const destPath = path.join(modsDir, file);
        const disabledPath = path.join(modsDir, file + '.disabled');

        const alreadyExists = fs.existsSync(destPath) || fs.existsSync(disabledPath);

        if (file.toLowerCase().includes('tuxclient')) {
          if (mcVersion === '1.21.1') {
            if (!alreadyExists) {
              try {
                fs.copyFileSync(sourcePath, destPath);
                console.log(`[TuxLauncher] Injected ${file} into 1.21.1 mods folder.`);
              } catch (err) {
                console.error(`[TuxLauncher Error] Failed to inject ${file}:`, err);
              }
            }
          } else {
            if (fs.existsSync(destPath)) try { fs.unlinkSync(destPath); } catch {}
            if (fs.existsSync(disabledPath)) try { fs.unlinkSync(disabledPath); } catch {}
          }
        } else {
          if (!alreadyExists) {
            try {
              fs.copyFileSync(sourcePath, destPath);
            } catch (err) {
              console.error(`[TuxLauncher Error] Failed to inject ${file}:`, err);
            }
          }
        }
      }
    });
  }
}

function getInstancePath(version = '1.21.1', loader = 'fabric') {
  const instanceDir = path.join(TUX_ROOT, 'instances', `${version}-${loader}`);
  const modsDir = path.join(instanceDir, 'mods');
  const resourcePacksDir = path.join(instanceDir, 'resourcepacks');
  const shaderPacksDir = path.join(instanceDir, 'shaderpacks');

  if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
  if (!fs.existsSync(resourcePacksDir)) fs.mkdirSync(resourcePacksDir, { recursive: true });
  if (!fs.existsSync(shaderPacksDir)) fs.mkdirSync(shaderPacksDir, { recursive: true });

  ensureBundledMods(modsDir, version);

  return { instanceDir, modsDir, resourcePacksDir, shaderPacksDir };
}

// --- FABRIC PROFILE GENERATION ---
async function ensureFabricProfile(instanceDir, mcVersion, fabricVersion = "0.19.3") {
  const cleanMcVersion = (mcVersion && typeof mcVersion === 'string' && mcVersion.trim() !== '') 
    ? mcVersion.trim() 
    : '1.21.1';

  const customName = `fabric-loader-${fabricVersion}-${cleanMcVersion}`;
  const versionFolder = path.join(instanceDir, 'versions', customName);
  const jsonPath = path.join(versionFolder, `${customName}.json`);

  if (!fs.existsSync(jsonPath)) {
    fs.mkdirSync(versionFolder, { recursive: true });
    const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(cleanMcVersion)}/${encodeURIComponent(fabricVersion)}/profile/json`;

    try {
      sendConsoleLog('info', `[TuxFabric] Fetching profile from: ${url}`);
      const res = await axios.get(url, { timeout: 10000 });
      fs.writeFileSync(jsonPath, JSON.stringify(res.data, null, 2));
    } catch (err) {
      sendConsoleLog('error', `[TuxFabric Error]: Failed to fetch Fabric profile for MC ${cleanMcVersion}`);
      throw new Error(`Failed to fetch Fabric profile: ${err.message}`);
    }
  }
  return customName;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "TuxClient",
    icon: path.join(__dirname, 'assets', 'logo.png'),
    width: 1050,
    height: 680,
    frame: false,
    resizable: true,
    backgroundColor: '#0D0D11',
    webPreferences: { 
      nodeIntegration: true, 
      contextIsolation: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  mainWindow.loadFile('index.html').catch(err => {
    console.error("[TuxLauncher Error] Failed to load index.html:", err);
  });

  mainWindow.on('close', (e) => {
    if (globalChatSocket && globalChatSocket.readyState === WebSocket.OPEN) {
      e.preventDefault();

      console.log(`[TuxLauncher] Transmitting explicit logout frame for user: ${currentActiveUsername}`);
      
      try {
        globalChatSocket.send(JSON.stringify({
          type: 'logout',
          username: currentActiveUsername
        }));
      } catch (err) {
        console.error('[TuxLauncher Shutdown Error]:', err.message);
      }

      setTimeout(() => {
        try { globalChatSocket.close(); } catch {}
        globalChatSocket = null;
        mainWindow.destroy();
      }, 150);
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (app.isPackaged) {
      autoUpdater.checkForUpdates();
    }
  });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.tuxclient.launcher');
  }

  createWindow();
  initDiscordRPC();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// --- WINDOW CONTROLS ---
ipcMain.on('window-minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('window-close', (event) => BrowserWindow.fromWebContents(event.sender)?.close());

// --- LAUNCHER WEBSOCKET & RENDER KEEP-ALIVE ---
let globalChatSocket = null;
let pingInterval = null;

function connectGlobalChat(username) {
  const normalizedUsername = username.toLowerCase().trim();
  currentActiveUsername = username;

  if (globalChatSocket) {
    try { globalChatSocket.close(); } catch {}
  }
  if (pingInterval) clearInterval(pingInterval);

  const connectionUrl = `${SERVER_WS_URL}?user=${encodeURIComponent(normalizedUsername)}`;
  console.log(`[TuxLauncher WS] Connecting to Render backend at: ${connectionUrl}`);

  globalChatSocket = new WebSocket(connectionUrl);

  globalChatSocket.on('open', () => {
    console.log(`[TuxLauncher WS] Connection OPENED successfully for user: ${username}`);

    const authPacket = {
      type: 'auth',
      username: username,
      uuid: normalizedUsername
    };
    globalChatSocket.send(JSON.stringify(authPacket));

    pingInterval = setInterval(() => {
      if (globalChatSocket && globalChatSocket.readyState === WebSocket.OPEN) {
        globalChatSocket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  });

  globalChatSocket.on('message', (data) => {
    try {
      const packet = JSON.parse(data.toString());
      if (packet.type === 'pong') return;

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('network-packet', packet);
      }
    } catch (err) {
      console.error('[GlobalChat Packet Error]:', err);
    }
  });

  globalChatSocket.on('close', () => {
    if (pingInterval) clearInterval(pingInterval);
  });

  globalChatSocket.on('error', (err) => {
    console.error('[GlobalChat Socket Error]:', err.message);
  });
}

ipcMain.handle('init-global-chat', (event, username) => {
  if (username) {
    connectGlobalChat(username);
    return { success: true };
  }
  return { success: false, message: 'Invalid username' };
});

ipcMain.handle('send-socket-packet', async (event, packet) => {
  if (!packet) return { success: false, message: 'Invalid packet payload' };

  if (packet.target) packet.target = packet.target.toLowerCase().trim();
  if (packet.recipient) packet.recipient = packet.recipient.toLowerCase().trim();
  if (packet.from) packet.from = packet.from.trim();

  if (globalChatSocket && globalChatSocket.readyState === WebSocket.OPEN) {
    globalChatSocket.send(JSON.stringify(packet));
    return { success: true };
  }
  return { success: false, message: 'Socket disconnected' };
});

ipcMain.handle('send-global-message', (event, { sender, text }) => {
  if (globalChatSocket && globalChatSocket.readyState === WebSocket.OPEN) {
    const packet = {
      type: 'global_chat',
      sender: sender,
      text: text,
      timestamp: Date.now()
    };
    globalChatSocket.send(JSON.stringify(packet));
    return { success: true };
  }
  return { success: false, message: 'Global chat server disconnected.' };
});

// --- FRIEND SYSTEM IPC HANDLERS ---
ipcMain.handle('send-friend-request', async (event, { targetUsername, senderUsername }) => {
  try {
    if (!targetUsername || !senderUsername) {
      return { success: false, message: 'Invalid username provided.' };
    }

    if (!globalChatSocket || globalChatSocket.readyState !== WebSocket.OPEN) {
      return { success: false, message: 'Launcher is not connected to backend server.' };
    }

    const packet = {
      type: 'friend_request',
      target: targetUsername.toLowerCase().trim(),
      from: senderUsername
    };

    globalChatSocket.send(JSON.stringify(packet));
    return { success: true, message: `Friend request sent to ${targetUsername}!` };
  } catch (err) {
    return { success: false, message: 'Failed to send friend request.' };
  }
});

ipcMain.handle('respond-friend-request', async (event, { targetUsername, action, currentUser }) => {
  try {
    if (globalChatSocket && globalChatSocket.readyState === WebSocket.OPEN) {
      const packet = {
        type: action === 'accept' ? 'friend_accept' : 'friend_decline',
        target: targetUsername.toLowerCase().trim(),
        from: currentUser
      };
      globalChatSocket.send(JSON.stringify(packet));
    }
    return { success: true };
  } catch (err) {
    return { success: false };
  }
});

// --- AUTHENTICATION & SILENT SESSION REFRESH ---
ipcMain.on('microsoft-login', async () => {
  try {
    const xboxManager = await authManager.launch("raw");
    const token = await xboxManager.getMinecraft();

    const accountData = {
      name: token.profile.name,
      uuid: token.profile.id,
      mclcAuth: token.mclc(),
      refreshToken: xboxManager.msToken?.refresh_token || xboxManager.refreshToken || null
    };

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-success', accountData);
    }
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-error', 'Login failed or session expired.');
    }
  }
});

ipcMain.handle('refresh-account-session', async (event, savedAccount) => {
  if (!savedAccount || !savedAccount.refreshToken) {
    return { success: false, message: 'No refresh token stored.' };
  }

  try {
    console.log(`[Auth] Silently renewing Minecraft access token for ${savedAccount.name}...`);
    sendConsoleLog('info', `[Auth] Renewing active Minecraft session for ${savedAccount.name}...`);

    const xboxManager = await authManager.refresh(savedAccount.refreshToken);
    const token = await xboxManager.getMinecraft();

    const updatedAccount = {
      name: token.profile.name,
      uuid: token.profile.id,
      mclcAuth: token.mclc(),
      refreshToken: xboxManager.msToken?.refresh_token || savedAccount.refreshToken
    };

    return { success: true, account: updatedAccount };
  } catch (err) {
    console.error('[Auth Refresh Error]:', err.message);
    sendConsoleLog('error', `[Auth Refresh Error] ${err.message}`);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('fetch-skin-base64', async (event, username) => {
  try {
    const profileRes = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`, { timeout: 8000 });
    const uuid = profileRes.data.id;
    const sessionRes = await axios.get(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`, { timeout: 8000 });
    const textureProperty = sessionRes.data.properties.find(p => p.name === 'textures');
    const decodedValue = JSON.parse(Buffer.from(textureProperty.value, 'base64').toString('utf8'));
    const skinUrl = decodedValue.textures?.SKIN?.url;
    const imgRes = await axios.get(skinUrl, { responseType: 'arraybuffer', timeout: 10000 });
    return `data:image/png;base64,${Buffer.from(imgRes.data, 'binary').toString('base64')}`;
  } catch (err) {
    try {
      const fallbackRes = await axios.get(`https://crafatar.com/skins/${encodeURIComponent(username)}`, { responseType: 'arraybuffer', timeout: 8000 });
      return `data:image/png;base64,${Buffer.from(fallbackRes.data, 'binary').toString('base64')}`;
    } catch {
      throw new Error(`Could not resolve skin texture for ${username}`);
    }
  }
});

// --- GAME LAUNCH ROUTINE ---
ipcMain.handle('get-mc-versions', async () => {
  try {
    const res = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', { timeout: 10000 });
    return res.data.versions;
  } catch {
    return [];
  }
});

ipcMain.on('launch-game', async (event, config) => {
  const selectedVersion = (config && config.version && typeof config.version === 'string' && config.version.trim() !== '')
    ? config.version.trim()
    : '1.21.1';
  const selectedLoader = (config && config.modLoader) ? config.modLoader : 'fabric';

  const ramMax = config && config.ram ? `${config.ram}G` : "4000M";
  const { instanceDir } = getInstancePath(selectedVersion, selectedLoader);
  const gameDir = path.join(app.getPath('appData'), '.minecraft');

  createTuxConsoleWindow();
  sendConsoleLog('info', `[TuxLauncher] Validating instance files and initializing launch routine for Minecraft ${selectedVersion}...`);

  sanitizeAndValidateInstanceFiles(path.join(gameDir, 'assets'));
  sanitizeAndValidateInstanceFiles(path.join(gameDir, 'versions'));
  sanitizeAndValidateInstanceFiles(path.join(instanceDir, 'libraries'));
  sanitizeAndValidateInstanceFiles(path.join(instanceDir, 'mods'));

  setLauncherActivity(`Playing Minecraft ${selectedVersion}`, `Loader: ${selectedLoader.toUpperCase()}`);

  try {
    const versionNum = parseFloat(selectedVersion);
    const requiredJavaVersion = (versionNum >= 25 || selectedVersion.startsWith('26.')) ? 25 : 21;

    let javaExecutable = null;

    sendConsoleLog('info', `[TuxJava] Checking for Java ${requiredJavaVersion} Runtime...`);
    javaExecutable = await ensurePortableJava(event, requiredJavaVersion);

    if (!javaExecutable || !fs.existsSync(javaExecutable)) {
      throw new Error(`Java binary not found on filesystem at: ${javaExecutable}`);
    }

    const javaBinFolder = path.dirname(javaExecutable);
    if (!process.env.PATH.includes(javaBinFolder)) {
      process.env.PATH = `${javaBinFolder};${process.env.PATH}`;
    }

    let authData = config ? config.auth : null;
    if (authData && authData.mclcAuth) {
      authData = authData.mclcAuth;
    } else if (!authData) {
      authData = {
        access_token: "offline_token",
        client_token: "offline_client",
        uuid: "offline_uuid",
        name: (config && config.username) ? config.username : "_Graptor_",
        user_properties: "{}"
      };
    }

    const opts = {
      authorization: authData,
      root: instanceDir,
      version: { number: selectedVersion, type: "release" },
      memory: { max: ramMax, min: "2000M" },
      executable: javaExecutable,
      javaPath: javaExecutable,
      customArgs: ["-Dorg.lwjgl.util.Debug=true", "-XX:+UnlockExperimentalVMOptions"]
    };

    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launch-status', `Preparing ${selectedVersion}...`);

    if (selectedLoader.toLowerCase() === 'fabric') {
      sendConsoleLog('info', '[TuxFabric] Resolving Fabric profile...');
      opts.version.custom = await ensureFabricProfile(instanceDir, selectedVersion, "0.19.3");
    }

    launcher.removeAllListeners();

    launcher.on('data', (e) => {
      const str = e ? e.toString().trim() : '';
      if (str) sendConsoleLog('mc', str);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launch-status', 'Launching Minecraft...');
      
      // Continuous heartbeat update to prevent Discord process timeout
      setLauncherActivity(`Playing Minecraft ${selectedVersion}`, `Loader: ${selectedLoader.toUpperCase()}`);
    });

    launcher.on('debug', (e) => {
      if (e) sendConsoleLog('debug', `[DEBUG] ${e}`);
    });

    launcher.on('error', (e) => {
      if (e) sendConsoleLog('error', `[ERROR] ${e}`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launch-status', `Error: ${e}`);
    });

    let lastPercent = -1;
    let lastProgressType = '';

    launcher.on('progress', (e) => {
      const percentage = Math.round((e.current / e.total) * 100) || 0;
      const currentType = e.type || "Downloading files...";

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launch-progress', { type: currentType, percent: percentage });
      }

      if (percentage !== lastPercent || currentType !== lastProgressType) {
        lastPercent = percentage;
        lastProgressType = currentType;
        sendConsoleLog('info', `[Download] ${currentType}: ${percentage}%`);
      }
    });

    launcher.on('close', (code) => {
      sendConsoleLog('info', `[TuxLauncher] Process exited with code ${code}`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launch-status', code === 0 ? 'Ready' : `Crashed (Exit code: ${code})`);
      setLauncherActivity('In Launcher', 'Browsing Mods & Profiles');
    });

    await launcher.launch(opts);
  } catch (err) {
    sendConsoleLog('error', `[CRASH EXCEPTION] ${err.stack || err.message}`);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launch-status', `Error: ${err.message}`);
    setLauncherActivity('In Launcher', 'Browsing Mods & Profiles');
  }
});

// --- MOD, RESOURCE PACK & SHADER MANAGEMENT ---
ipcMain.handle('get-installed-mods', async (event, { version = '1.21.1', loader = 'fabric' } = {}) => {
  const { modsDir } = getInstancePath(version, loader);
  if (!fs.existsSync(modsDir)) return [];

  return fs.readdirSync(modsDir)
    .filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
    .map(f => ({
      fileName: f, 
      name: f.replace('.disabled', '').replace('.jar', ''), 
      enabled: !f.endsWith('.disabled'),
      isBundled: f.toLowerCase().includes('tuxclient')
    }));
});

ipcMain.handle('toggle-mod', async (event, { version = '1.21.1', loader = 'fabric', fileName, enable }) => {
  const { modsDir } = getInstancePath(version, loader);
  const cur = path.join(modsDir, fileName);
  if (!fs.existsSync(cur)) return { success: false };
  const target = enable ? fileName.replace('.disabled', '') : fileName + '.disabled';
  fs.renameSync(cur, path.join(modsDir, target));
  return { success: true };
});

ipcMain.handle('delete-mod', async (event, { version = '1.21.1', loader = 'fabric', fileName }) => {
  const { modsDir } = getInstancePath(version, loader);
  const p = path.join(modsDir, fileName);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return { success: true };
});

ipcMain.handle('get-installed-packs', async (event, { version = '1.21.1', loader = 'fabric', type = 'resourcepacks' } = {}) => {
  const paths = getInstancePath(version, loader);
  const targetDir = type === 'shaders' ? paths.shaderPacksDir : paths.resourcePacksDir;
  if (!fs.existsSync(targetDir)) return [];
  return fs.readdirSync(targetDir).map(f => ({ fileName: f, name: f.replace('.zip', '') }));
});

ipcMain.handle('delete-pack', async (event, { version = '1.21.1', loader = 'fabric', type = 'resourcepacks', fileName }) => {
  const paths = getInstancePath(version, loader);
  const targetDir = type === 'shaders' ? paths.shaderPacksDir : paths.resourcePacksDir;
  const p = path.join(targetDir, fileName);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  return { success: true };
});

ipcMain.handle('search-modrinth', async (event, { query, version, loader = 'fabric', projectType = 'mod' }) => {
  try {
    let facets = projectType === 'mod' 
      ? `[["categories:${loader}"],["versions:${version}"],["project_type:mod"]]` 
      : `[["versions:${version}"],["project_type:${projectType}"]]`;
    const res = await axios.get(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&limit=12`, { headers: { 'User-Agent': 'TuxClient/1.0.0' } });
    return res.data.hits;
  } catch { return []; }
});

ipcMain.handle('download-content-file', async (event, { projectId, version = '1.21.1', loader = 'fabric', projectType = 'mod' }) => {
  const paths = getInstancePath(version, loader);
  let targetDir = paths.modsDir;
  if (projectType === 'resourcepack') targetDir = paths.resourcePacksDir;
  if (projectType === 'shader') targetDir = paths.shaderPacksDir;

  let versionUrl = `https://api.modrinth.com/v2/project/${projectId}/version?game_versions=["${encodeURIComponent(version)}"]`;
  if (projectType === 'mod') {
    versionUrl += `&loaders=["${encodeURIComponent(loader.toLowerCase())}"]`;
  }

  const vRes = await axios.get(versionUrl, { headers: { 'User-Agent': 'TuxClient/1.0.0' } });
  if (!vRes.data || !vRes.data.length) {
    throw new Error(`No compatible ${projectType} file found for Minecraft ${version} (${loader}).`);
  }

  const stableVersion = vRes.data.find(v => v.version_type === 'release') || vRes.data[0];
  const fileInfo = stableVersion.files.find(f => f.primary) || stableVersion.files[0];
  const filePath = path.join(targetDir, fileInfo.filename);

  const response = await axios({ url: fileInfo.url, method: 'GET', responseType: 'stream' });
  const totalLength = parseInt(response.headers['content-length'], 10);
  let downloadedLength = 0;

  const writer = fs.createWriteStream(filePath);

  response.data.on('data', (chunk) => {
    downloadedLength += chunk.length;
    if (totalLength) {
      const percent = Math.round((downloadedLength / totalLength) * 100);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launch-progress', { type: `Downloading ${fileInfo.filename}...`, percent });
      }
    }
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launch-progress', { type: 'Download Complete!', percent: 100 });
        setTimeout(() => mainWindow.webContents.send('launch-status', 'Ready'), 1500);
      }
      resolve(fileInfo.filename);
    });
    writer.on('error', reject);
  });
});

ipcMain.handle('download-content-version-id', async (event, { projectId, versionId, version = '1.21.1', loader = 'fabric' }) => {
  const paths = getInstancePath(version, loader);
  const targetDir = paths.modsDir;

  const vRes = await axios.get(`https://api.modrinth.com/v2/version/${versionId}`, { headers: { 'User-Agent': 'TuxClient/1.0.0' } });
  if (!vRes.data) throw new Error('Selected version build not found.');

  const fileInfo = vRes.data.files.find(f => f.primary) || vRes.data.files[0];
  const filePath = path.join(targetDir, fileInfo.filename);

  const response = await axios({ url: fileInfo.url, method: 'GET', responseType: 'stream' });
  const totalLength = parseInt(response.headers['content-length'], 10);
  let downloadedLength = 0;

  const writer = fs.createWriteStream(filePath);

  response.data.on('data', (chunk) => {
    downloadedLength += chunk.length;
    if (totalLength) {
      const percent = Math.round((downloadedLength / totalLength) * 100);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launch-progress', { type: `Downloading ${fileInfo.filename}...`, percent });
      }
    }
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launch-progress', { type: 'Download Complete!', percent: 100 });
        setTimeout(() => mainWindow.webContents.send('launch-status', 'Ready'), 1500);
      }
      resolve(fileInfo.filename);
    });
    writer.on('error', reject);
  });
});

// --- MISC UTILITIES ---
ipcMain.handle('get-autostart-status', () => app.getLoginItemSettings().openAtLogin);
ipcMain.on('set-autostart', (event, enable) => app.setLoginItemSettings({ openAtLogin: enable, path: app.getPath('exe') }));
ipcMain.on('open-game-folder', () => {
  if (!fs.existsSync(TUX_ROOT)) fs.mkdirSync(TUX_ROOT, { recursive: true });
  shell.openPath(TUX_ROOT);
});

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());