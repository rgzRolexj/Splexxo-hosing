const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');

// Firebase initialization with your config
const firebaseConfig = {
  apiKey: "AIzaSyA0_l3o6qOzfelyDAuNKAu2p1gt--I7Zq8",
  authDomain: "bot-hosing.firebaseapp.com",
  databaseURL: "https://bot-hosing-default-rtdb.firebaseio.com",
  projectId: "bot-hosing",
  storageBucket: "bot-hosing.firebasestorage.app",
  messagingSenderId: "892256984514",
  appId: "1:892256984514:web:ef8575d05e91527d1b0a5b"
};

// Initialize Firebase Admin SDK (using env vars for secrets)
const serviceAccount = {
  type: "service_account",
  project_id: firebaseConfig.projectId,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509 || ""
};

// Initialize Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: firebaseConfig.databaseURL,
    storageBucket: firebaseConfig.storageBucket
  });
  console.log('✅ Firebase Admin initialized successfully');
} catch (error) {
  console.log('⚠️ Firebase Admin already initialized or failed:', error.message);
}

const db = admin.firestore();
const app = express();

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(__dirname, 'uploads', req.body.userId || 'anonymous');
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.py', '.js', '.zip'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    
    if (allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only .py, .js, and .zip files are allowed.'));
    }
  }
});

// Store running processes
const runningProcesses = new Map();

// Utility functions
class APIUtils {
  static async saveToFirebase(userId, fileInfo, processInfo = null) {
    try {
      const userRef = db.collection('users').doc(userId);
      
      // Update user data
      await userRef.set({
        userId: userId,
        lastActive: admin.firestore.FieldValue.serverTimestamp(),
        totalFiles: admin.firestore.FieldValue.increment(1)
      }, { merge: true });

      // Save file info
      const filesRef = userRef.collection('files').doc(fileInfo.filename);
      await filesRef.set({
        filename: fileInfo.filename,
        fileType: fileInfo.fileType,
        originalName: fileInfo.originalName,
        uploadTime: admin.firestore.FieldValue.serverTimestamp(),
        status: 'uploaded',
        size: fileInfo.size,
        path: fileInfo.path
      });

      // Save process info if available
      if (processInfo) {
        const processRef = userRef.collection('processes').doc(fileInfo.filename);
        await processRef.set({
          ...processInfo,
          lastUpdate: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Update statistics
      await this.updateStatistics(userId, 'file_upload');
      
      return true;
    } catch (error) {
      console.error('Firebase save error:', error);
      return false;
    }
  }

  static async updateStatistics(userId, action) {
    try {
      const statsRef = db.collection('statistics').doc('global');
      const userStatsRef = db.collection('users').doc(userId).collection('stats').doc('usage');
      
      const updateData = {};
      updateData[action] = admin.firestore.FieldValue.increment(1);
      updateData.lastUpdate = admin.firestore.FieldValue.serverTimestamp();

      await statsRef.set(updateData, { merge: true });
      await userStatsRef.set(updateData, { merge: true });
      
    } catch (error) {
      console.error('Statistics update error:', error);
    }
  }

  static async getUserFiles(userId) {
    try {
      const filesRef = db.collection('users').doc(userId).collection('files');
      const snapshot = await filesRef.orderBy('uploadTime', 'desc').get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Firebase get files error:', error);
      return [];
    }
  }

  static async getRunningProcesses(userId) {
    try {
      const processesRef = db.collection('users').doc(userId).collection('processes');
      const snapshot = await processesRef.get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Firebase get processes error:', error);
      return [];
    }
  }

  static async getUserInfo(userId) {
    try {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();
      
      if (userDoc.exists) {
        return userDoc.data();
      } else {
        // Create user if doesn't exist
        await userRef.set({
          userId: userId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          totalFiles: 0,
          status: 'active'
        });
        return await userRef.get().then(doc => doc.data());
      }
    } catch (error) {
      console.error('Get user info error:', error);
      return null;
    }
  }

  static extractZip(zipPath, extractPath) {
    return new Promise((resolve, reject) => {
      try {
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractPath, true);
        resolve(true);
      } catch (error) {
        reject(error);
      }
    });
  }

  static installPythonPackage(packageName) {
    return new Promise((resolve, reject) => {
      const command = `pip install ${packageName}`;
      
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error(`Installation error for ${packageName}:`, stderr);
          reject(error);
        } else {
          console.log(`Successfully installed ${packageName}`);
          resolve(stdout);
        }
      });
    });
  }

  static installNodePackage(packageName, userDir) {
    return new Promise((resolve, reject) => {
      const command = `cd "${userDir}" && npm install ${packageName}`;
      
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error(`NPM installation error for ${packageName}:`, stderr);
          reject(error);
        } else {
          console.log(`Successfully installed ${packageName}`);
          resolve(stdout);
        }
      });
    });
  }
}

// Process Management Class
class ProcessManager {
  static runPythonScript(scriptPath, userId, filename) {
    return new Promise(async (resolve, reject) => {
      const scriptKey = `${userId}_${filename}`;
      const logPath = `${scriptPath}.log`;
      
      try {
        // Check if file exists
        if (!fs.existsSync(scriptPath)) {
          throw new Error(`Script file not found: ${scriptPath}`);
        }

        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        
        const process = spawn('python', [scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: path.dirname(scriptPath)
        });

        process.stdout.on('data', (data) => {
          logStream.write(`[STDOUT] ${data}`);
        });

        process.stderr.on('data', (data) => {
          logStream.write(`[STDERR] ${data}`);
        });

        process.on('error', (error) => {
          logStream.write(`[ERROR] Process error: ${error.message}`);
          reject(error);
        });

        process.on('close', (code) => {
          logStream.write(`[INFO] Process exited with code ${code}`);
          logStream.end();
          runningProcesses.delete(scriptKey);
          APIUtils.updateProcessStatus(userId, filename, 'stopped', code);
        });

        const processInfo = {
          pid: process.pid,
          filename: filename,
          userId: userId,
          startTime: new Date().toISOString(),
          type: 'python',
          status: 'running',
          logPath: logPath,
          scriptPath: scriptPath
        };

        runningProcesses.set(scriptKey, {
          process: process,
          info: processInfo
        });

        await APIUtils.saveToFirebase(userId, {
          filename: filename,
          fileType: 'py',
          originalName: filename,
          size: fs.statSync(scriptPath).size,
          path: scriptPath
        }, processInfo);

        await APIUtils.updateStatistics(userId, 'script_start');

        resolve(processInfo);
      } catch (error) {
        reject(error);
      }
    });
  }

  static runNodeScript(scriptPath, userId, filename) {
    return new Promise(async (resolve, reject) => {
      const scriptKey = `${userId}_${filename}`;
      const logPath = `${scriptPath}.log`;
      
      try {
        if (!fs.existsSync(scriptPath)) {
          throw new Error(`Script file not found: ${scriptPath}`);
        }

        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        
        const process = spawn('node', [scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: path.dirname(scriptPath)
        });

        process.stdout.on('data', (data) => {
          logStream.write(`[STDOUT] ${data}`);
        });

        process.stderr.on('data', (data) => {
          logStream.write(`[STDERR] ${data}`);
        });

        process.on('error', (error) => {
          logStream.write(`[ERROR] Process error: ${error.message}`);
          reject(error);
        });

        process.on('close', (code) => {
          logStream.write(`[INFO] Process exited with code ${code}`);
          logStream.end();
          runningProcesses.delete(scriptKey);
          APIUtils.updateProcessStatus(userId, filename, 'stopped', code);
        });

        const processInfo = {
          pid: process.pid,
          filename: filename,
          userId: userId,
          startTime: new Date().toISOString(),
          type: 'node',
          status: 'running',
          logPath: logPath,
          scriptPath: scriptPath
        };

        runningProcesses.set(scriptKey, {
          process: process,
          info: processInfo
        });

        await APIUtils.saveToFirebase(userId, {
          filename: filename,
          fileType: 'js',
          originalName: filename,
          size: fs.statSync(scriptPath).size,
          path: scriptPath
        }, processInfo);

        await APIUtils.updateStatistics(userId, 'script_start');

        resolve(processInfo);
      } catch (error) {
        reject(error);
      }
    });
  }

  static stopProcess(userId, filename) {
    return new Promise(async (resolve, reject) => {
      const scriptKey = `${userId}_${filename}`;
      const processData = runningProcesses.get(scriptKey);
      
      if (!processData) {
        reject(new Error('Process not found'));
        return;
      }

      try {
        processData.process.kill();
        runningProcesses.delete(scriptKey);
        await APIUtils.updateProcessStatus(userId, filename, 'stopped', 0);
        await APIUtils.updateStatistics(userId, 'script_stop');
        resolve({ message: 'Process stopped successfully' });
      } catch (error) {
        reject(error);
      }
    });
  }

  static getProcessStatus(userId, filename) {
    const scriptKey = `${userId}_${filename}`;
    const processData = runningProcesses.get(scriptKey);
    
    if (!processData) {
      return { status: 'stopped' };
    }

    return {
      status: 'running',
      info: processData.info
    };
  }

  static async updateProcessStatus(userId, filename, status, exitCode = null) {
    try {
      const processRef = db.collection('users').doc(userId).collection('processes').doc(filename);
      const updateData = {
        status: status,
        lastUpdate: admin.firestore.FieldValue.serverTimestamp()
      };
      
      if (exitCode !== null) {
        updateData.exitCode = exitCode;
        updateData.endTime = new Date().toISOString();
      }
      
      await processRef.set(updateData, { merge: true });
    } catch (error) {
      console.error('Update process status error:', error);
    }
  }
}

// Link helper
APIUtils.updateProcessStatus = ProcessManager.updateProcessStatus;

// API Routes

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const statsRef = db.collection('statistics').doc('global');
    const statsDoc = await statsRef.get();
    const stats = statsDoc.exists ? statsDoc.data() : {};

    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      runningProcesses: runningProcesses.size,
      firebase: 'connected',
      statistics: stats
    });
  } catch (error) {
    res.status(500).json({ error: 'Health check failed', details: error.message });
  }
});

// Get user information
app.get('/api/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const userInfo = await APIUtils.getUserInfo(userId);
    
    if (userInfo) {
      const files = await APIUtils.getUserFiles(userId);
      const processes = await APIUtils.getRunningProcesses(userId);
      
      res.json({
        success: true,
        user: userInfo,
        files: files,
        runningProcesses: processes
      });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get user info', 
      details: error.message 
    });
  }
});

// Upload and run script
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { userId, autoStart = 'true' } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const file = req.file;
    const fileExtension = path.extname(file.originalname).toLowerCase();
    const userDir = path.dirname(file.path);

    let result;

    if (fileExtension === '.zip') {
      const extractPath = path.join(userDir, 'extracted');
      if (!fs.existsSync(extractPath)) {
        fs.mkdirSync(extractPath);
      }

      await APIUtils.extractZip(file.path, extractPath);
      
      const files = fs.readdirSync(extractPath);
      const pyFiles = files.filter(f => f.endsWith('.py'));
      const jsFiles = files.filter(f => f.endsWith('.js'));

      let mainFile;
      if (pyFiles.includes('main.py')) mainFile = 'main.py';
      else if (pyFiles.includes('bot.py')) mainFile = 'bot.py';
      else if (pyFiles.length > 0) mainFile = pyFiles[0];
      else if (jsFiles.includes('index.js')) mainFile = 'index.js';
      else if (jsFiles.includes('app.js')) mainFile = 'app.js';
      else if (jsFiles.length > 0) mainFile = jsFiles[0];
      else {
        throw new Error('No valid script files found in ZIP');
      }

      const mainFilePath = path.join(extractPath, mainFile);
      const fileType = mainFile.endsWith('.py') ? 'py' : 'js';

      if (fs.existsSync(path.join(extractPath, 'requirements.txt'))) {
        console.log('Installing Python requirements...');
        await new Promise((resolve) => {
          exec(`cd "${extractPath}" && pip install -r requirements.txt`, 
            (error, stdout, stderr) => {
              if (error) console.error('Requirements installation error:', stderr);
              resolve();
            });
        });
      }

      if (fs.existsSync(path.join(extractPath, 'package.json'))) {
        console.log('Installing Node dependencies...');
        await new Promise((resolve) => {
          exec(`cd "${extractPath}" && npm install`, 
            (error, stdout, stderr) => {
              if (error) console.error('NPM installation error:', stderr);
              resolve();
            });
        });
      }

      if (autoStart === 'true') {
        if (fileType === 'py') {
          result = await ProcessManager.runPythonScript(mainFilePath, userId, mainFile);
        } else {
          result = await ProcessManager.runNodeScript(mainFilePath, userId, mainFile);
        }
      }

    } else {
      const fileType = fileExtension === '.py' ? 'py' : 'js';
      
      if (autoStart === 'true') {
        if (fileType === 'py') {
          result = await ProcessManager.runPythonScript(file.path, userId, file.originalname);
        } else {
          result = await ProcessManager.runNodeScript(file.path, userId, file.originalname);
        }
      }
    }

    res.json({
      success: true,
      message: 'File uploaded successfully',
      result: result,
      userId: userId
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'File upload failed', 
      details: error.message 
    });
  }
});

// Get user files
app.get('/api/files/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const files = await APIUtils.getUserFiles(userId);
    
    const filesWithStatus = files.map(file => {
      const status = ProcessManager.getProcessStatus(userId, file.filename);
      return {
        ...file,
        processStatus: status.status,
        processInfo: status.info
      };
    });

    res.json({
      success: true,
      files: filesWithStatus
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get files', 
      details: error.message 
    });
  }
});

// Start a script
app.post('/api/start/:userId/:filename', async (req, res) => {
  try {
    const { userId, filename } = req.params;
    const userDir = path.join(__dirname, 'uploads', userId);
    const filePath = path.join(userDir, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const fileExtension = path.extname(filename).toLowerCase();
    let result;

    if (fileExtension === '.py') {
      result = await ProcessManager.runPythonScript(filePath, userId, filename);
    } else if (fileExtension === '.js') {
      result = await ProcessManager.runNodeScript(filePath, userId, filename);
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    res.json({
      success: true,
      message: 'Script started successfully',
      result: result
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to start script', 
      details: error.message 
    });
  }
});

// Stop a script
app.post('/api/stop/:userId/:filename', async (req, res) => {
  try {
    const { userId, filename } = req.params;
    const result = await ProcessManager.stopProcess(userId, filename);
    
    res.json({
      success: true,
      message: 'Script stopped successfully',
      result: result
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to stop script', 
      details: error.message 
    });
  }
});

// Get process status
app.get('/api/status/:userId/:filename', (req, res) => {
  try {
    const { userId, filename } = req.params;
    const status = ProcessManager.getProcessStatus(userId, filename);
    
    res.json({
      success: true,
      status: status
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get status', 
      details: error.message 
    });
  }
});

// Get logs
app.get('/api/logs/:userId/:filename', (req, res) => {
  try {
    const { userId, filename } = req.params;
    const userDir = path.join(__dirname, 'uploads', userId);
    const scriptPath = path.join(userDir, filename);
    const logPath = `${scriptPath}.log`;
    
    if (fs.existsSync(logPath)) {
      const logs = fs.readFileSync(logPath, 'utf8');
      res.json({
        success: true,
        logs: logs
      });
    } else {
      res.json({
        success: true,
        logs: 'No logs available'
      });
    }
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get logs', 
      details: error.message 
    });
  }
});

// Delete file
app.delete('/api/files/:userId/:filename', async (req, res) => {
  try {
    const { userId, filename } = req.params;
    
    try {
      await ProcessManager.stopProcess(userId, filename);
    } catch (error) {
      // process may not be running, ignore
    }

    const fileRef = db.collection('users').doc(userId).collection('files').doc(filename);
    await fileRef.delete();

    const processRef = db.collection('users').doc(userId).collection('processes').doc(filename);
    await processRef.delete();

    const userDir = path.join(__dirname, 'uploads', userId);
    const filePath = path.join(userDir, filename);
    const logPath = `${filePath}.log`;

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }

    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      totalFiles: admin.firestore.FieldValue.increment(-1)
    });

    res.json({
      success: true,
      message: 'File deleted successfully'
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to delete file', 
      details: error.message 
    });
  }
});

// Get statistics
app.get('/api/statistics', async (req, res) => {
  try {
    const statsRef = db.collection('statistics').doc('global');
    const statsDoc = await statsRef.get();
    
    const usersRef = db.collection('users');
    const usersSnapshot = await usersRef.get();
    
    const statistics = {
      totalUsers: usersSnapshot.size,
      totalProcesses: runningProcesses.size,
      ...(statsDoc.exists ? statsDoc.data() : {})
    };

    res.json({
      success: true,
      statistics: statistics
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get statistics', 
      details: error.message 
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('API Error:', error);
  res.status(500).json({ 
    error: 'Internal server error', 
    details: error.message 
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 API Server running on port ${PORT}`);
  console.log(`📁 Upload directory: ${path.join(__dirname, 'uploads')}`);
  console.log(`🔥 Firebase connected to project: ${firebaseConfig.projectId}`);
  console.log(`🌐 Database URL: ${firebaseConfig.databaseURL}`);
});

module.exports = app;
