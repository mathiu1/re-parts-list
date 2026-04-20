const express = require('express');
const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const Part = require('../models/Part');
const { protect, adminOnly } = require('../middleware/auth');
const { createPasswordZip } = require('../utils/zip');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const lookupService = require('../utils/lookupService');

const router = express.Router();

// Global progress tracker for long-running exports
let exportProgress = { current: 0, total: 0, status: 'idle', type: '' };

// Multer config — store in memory for Cloudinary upload
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB server-side limit (client compresses to 200kb)
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  },
});

// Helper: upload buffer to Cloudinary
const uploadToCloudinary = (buffer, publicId) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        folder: 're-parts-list',
        resource_type: 'image',
        overwrite: true,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
};

// Helper: Build Excel Workbook with Images
const buildExcelWorkbook = async (parts, onProgress, checkCancelled) => {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('RE Parts');

  worksheet.columns = [
    { key: 'partNumber', width: 25 },
    { key: 'description', width: 40 },
    { key: 'location', width: 25 },
    { key: 'model', width: 25 },
    { key: 'color', width: 20 },
    { key: 'supplierName', width: 30 },
    { key: 'movingType', width: 15 },
    { key: 'image', width: 45 },
  ];

  const totalParts = parts.length;

  // Master Header
  worksheet.addRow(['RE PARTS LIST REPORT - ' + new Date().toLocaleDateString()]);
  worksheet.mergeCells('A1:H1');
  const titleCell = worksheet.getCell('A1');
  titleCell.font = { size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  worksheet.getRow(1).height = 45;

  // Data Headers Row
  const headerRow = worksheet.addRow(['Part Number', 'Description', 'Location', 'Model', 'Color', 'Supplier Name', 'Moving Type', 'Original Image']);
  headerRow.font = { size: 12, bold: true, color: { argb: 'FF1F2937' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
  headerRow.height = 30;
  headerRow.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
    };
  });

  const BATCH_SIZE = 50;
  for (let i = 0; i < totalParts; i += BATCH_SIZE) {
    if (checkCancelled && checkCancelled()) break;
    const batch = parts.slice(i, i + BATCH_SIZE);

    const imageDataBatch = await Promise.all(batch.map(async (part) => {
      try {
        const response = await axios.get(part.imageUrl, {
          responseType: 'arraybuffer',
          timeout: 15000
        });
        const ext = part.imageUrl.split('.').pop().split('?')[0] || 'jpg';
        return {
          part,
          buffer: Buffer.from(response.data),
          extension: ext.toLowerCase() === 'png' ? 'png' : 'jpeg'
        };
      } catch (err) {
        return { part, error: true };
      }
    }));

    imageDataBatch.forEach((data, index) => {
      const part = data.part;
      const rowNumber = i + index + 3;

      const formattedLocation = part.location ? part.location.split(',').map(l => l.trim()).join('\n') : '-';
      const numericPartNumber = !isNaN(part.partNumber) ? Number(part.partNumber) : part.partNumber;

      const row = worksheet.addRow({
        partNumber: numericPartNumber,
        description: part.description || '-',
        location: formattedLocation,
        model: part.model || '-',
        color: part.color || '-',
        supplierName: part.supplierName || '-',
        movingType: part.movingType || '-'
      });

      row.height = 140;
      row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        };
        cell.font = { size: 12 };
      });

      if (!data.error && data.buffer) {
        try {
          const imageId = workbook.addImage({
            buffer: data.buffer,
            extension: data.extension,
          });

          worksheet.addImage(imageId, {
            tl: { col: 7.15, row: rowNumber - 1 + 0.15 },
            ext: { width: 170, height: 170 },
            editAs: 'oneCell'
          });
        } catch (imgErr) {
          console.error(`Error adding image to workbook for ${part.partNumber}:`, imgErr.message);
        }
      }

      if (onProgress) onProgress(i + index + 1);
    });
  }

  return workbook;
};

// GET /api/parts — Paginated list with search (optimized)
router.get('/', protect, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    const query = search
      ? {
        $or: [
          { partNumber: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } },
        ],
      }
      : {};

    const [parts, total] = await Promise.all([
      Part.find(query)
        .select('partNumber description location uomDimension model color supplierName movingType imageUrl createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Part.countDocuments(query),
    ]);

    res.json({
      parts,
      page,
      totalPages: Math.ceil(total / limit),
      totalParts: total,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/parts/lookup/:partNumber — Fast lookup from Excel
router.get('/lookup/:partNumber', protect, (req, res) => {
  const details = lookupService.findPart(req.params.partNumber);
  if (!details) {
    return res.status(404).json({ message: 'Part not found in master list' });
  }
  res.json(details);
});

// GET /api/parts/search-lookup — Autocomplete suggestions from Excel
router.get('/search-lookup', protect, (req, res) => {
  const { q } = req.query;
  const results = lookupService.searchParts(q);
  res.json(results);
});

// GET /api/parts/:id — Single part
router.get('/:id', protect, async (req, res) => {
  try {
    const part = await Part.findById(req.params.id).populate('uploadedBy', 'username');
    if (!part) {
      return res.status(404).json({ message: 'Part not found' });
    }
    res.json(part);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/parts — Create new part
router.post('/', protect, upload.single('image'), async (req, res) => {
  try {
    const { partNumber } = req.body;

    if (!partNumber || !req.file) {
      return res.status(400).json({ message: 'Part number and image are required' });
    }

    // Check for duplicate
    const existing = await Part.findOne({ partNumber: partNumber.trim() });
    if (existing) {
      return res.status(409).json({ message: 'Part already exists' });
    }

    // Upload to Cloudinary with partNumber as public_id
    const result = await uploadToCloudinary(req.file.buffer, partNumber.trim());

    const { description, location, uomDimension, model, color, supplierName, movingType } = req.body;

    const part = await Part.create({
      partNumber: partNumber.trim(),
      description,
      location,
      uomDimension,
      model,
      color,
      supplierName,
      movingType,
      imageUrl: result.secure_url,
      cloudinaryPublicId: result.public_id,
      uploadedBy: req.user._id,
    });

    res.status(201).json(part);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Part already exists' });
    }
    res.status(500).json({ message: error.message });
  }
});

// PUT /api/parts/:id — Update part (Admin only)
router.put('/:id', protect, adminOnly, upload.single('image'), async (req, res) => {
  try {
    const part = await Part.findById(req.params.id);
    if (!part) {
      return res.status(404).json({ message: 'Part not found' });
    }

    const { partNumber, description, location, uomDimension, model, color, supplierName, movingType } = req.body;

    // If partNumber changed, check for duplicates
    if (partNumber && partNumber.trim() !== part.partNumber) {
      const existing = await Part.findOne({ partNumber: partNumber.trim() });
      if (existing) {
        return res.status(409).json({ message: 'Part number already exists' });
      }
    }

    // If new image uploaded, re-upload to Cloudinary
    if (req.file) {
      // Delete old image from Cloudinary (if it exists)
      if (part.cloudinaryPublicId) {
        await cloudinary.uploader.destroy(part.cloudinaryPublicId);
      }

      const newPublicId = partNumber ? partNumber.trim() : part.partNumber;
      const result = await uploadToCloudinary(req.file.buffer, newPublicId);

      part.imageUrl = result.secure_url;
      part.cloudinaryPublicId = result.public_id;
    } else if (partNumber && partNumber.trim() !== part.partNumber) {
      // If only partNumber changed (no new image), rename in Cloudinary (if it exists)
      if (part.cloudinaryPublicId) {
        const newPublicId = `re-parts-list/${partNumber.trim()}`;
        await cloudinary.uploader.rename(part.cloudinaryPublicId, newPublicId);
        part.cloudinaryPublicId = newPublicId;
      }
    }

    if (partNumber) part.partNumber = partNumber.trim();
    if (description !== undefined) part.description = description;
    if (location !== undefined) part.location = location;
    if (uomDimension !== undefined) part.uomDimension = uomDimension;
    if (model !== undefined) part.model = model;
    if (color !== undefined) part.color = color;
    if (supplierName !== undefined) part.supplierName = supplierName;
    if (movingType !== undefined) part.movingType = movingType;

    await part.save();
    res.json(part);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Part number already exists' });
    }
    res.status(500).json({ message: error.message });
  }
});

// DELETE /api/parts/:id — Delete part (Admin only)
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const part = await Part.findById(req.params.id);
    if (!part) {
      return res.status(404).json({ message: 'Part not found' });
    }

    // Delete from Cloudinary (if it exists)
    if (part.cloudinaryPublicId) {
      await cloudinary.uploader.destroy(part.cloudinaryPublicId);
    }

    // Delete from DB
    await Part.findByIdAndDelete(req.params.id);

    res.json({ message: 'Part deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/parts/export/status — Check progress of active export
router.get('/export/status', protect, adminOnly, (req, res) => {
  res.json(exportProgress);
});

// GET /api/parts/export/zip — Download all images as password-protected ZIP (Admin only)
router.get('/export/zip', protect, adminOnly, async (req, res) => {
  let isCancelled = false;
  req.on('close', () => {
    if (!res.writableEnded) {
      isCancelled = true;
      console.log('🛑 ZIP Export cancelled by user or connection lost.');
    }
  });

  try {
    const parts = await Part.find({});

    if (parts.length === 0) {
      return res.status(404).json({ message: 'No parts to export' });
    }

    // Initialize Tracker
    exportProgress = { current: 0, total: parts.length, status: 'processing', type: 'ZIP' };

    // Fetch all images
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      if (isCancelled) break;
      const part = parts[i];
      try {
        const response = await axios.get(part.imageUrl, { responseType: 'arraybuffer' });
        const ext = part.imageUrl.split('.').pop().split('?')[0] || 'jpg';
        const sanitizedPartNumber = part.partNumber.replace(/[^a-zA-Z0-9]/g, '');
        files.push({
          name: `${sanitizedPartNumber}.${ext}`,
          buffer: Buffer.from(response.data),
        });
        exportProgress.current = i + 1;
      } catch (err) {
        console.warn(`Failed to fetch image for part ${part.partNumber}: ${err.message}`);
      }
    }

    if (files.length === 0) {
      exportProgress.status = 'idle';
      return res.status(500).json({ message: 'Failed to fetch any images' });
    }

    const password = process.env.ZIP_PASSWORD || 'default_password';

    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const tempFile = path.join(tempDir, `export-${Date.now()}.zip`);

    const outputStream = fs.createWriteStream(tempFile);
    await createPasswordZip(files, password, outputStream);

    const stat = fs.statSync(tempFile);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=re-parts-images.zip');
    res.setHeader('Content-Length', stat.size);

    const readStream = fs.createReadStream(tempFile);
    readStream.pipe(res);

    readStream.on('end', () => {
      fs.unlink(tempFile, (err) => {
        if (err) console.error('Cleanup temp err:', err);
      });
    });
  } catch (error) {
    console.error('ZIP export error:', error);
    res.status(500).json({ message: 'Failed to create ZIP archive' });
  }
});

// GET /api/parts/export/excel — Download all images and data as Excel (Admin only)
router.get('/export/excel', protect, adminOnly, async (req, res) => {
  let isCancelled = false;
  req.on('close', () => {
    if (!res.writableEnded) {
      isCancelled = true;
      console.log('🛑 Excel Export cancelled by user or connection lost.');
    }
  });

  try {
    const parts = await Part.find({});

    if (parts.length === 0) {
      return res.status(404).json({ message: 'No parts to export' });
    }

    const totalParts = parts.length;
    // Initialize Tracker
    exportProgress = { current: 0, total: totalParts, status: 'processing', type: 'Excel' };

    const workbook = await buildExcelWorkbook(
      parts,
      (current) => { exportProgress.current = current; },
      () => isCancelled
    );

    if (isCancelled) return;

    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const tempFile = path.join(tempDir, `export-excel-${Date.now()}.xlsx`);

    await workbook.xlsx.writeFile(tempFile);
    console.log('✅ Workbook saved to disk.');

    // Finalize Tracker
    exportProgress.status = 'idle';

    const stat = fs.statSync(tempFile);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=re-parts-list.xlsx');
    res.setHeader('Content-Length', stat.size);

    const readStream = fs.createReadStream(tempFile);
    readStream.pipe(res);

    readStream.on('end', () => {
      fs.unlink(tempFile, (err) => {
        if (err) console.error('Cleanup temp excel err:', err);
      });
    });

  } catch (error) {
    console.error('Excel export error:', error);
    exportProgress.status = 'idle';
    res.status(500).json({ message: 'Failed to create Excel file' });
  }
});

const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5173/google-callback'
);

// @route   GET /api/parts/export/google/auth-url
// @desc    Get Google OAuth URL
// @access  Admin only
router.get('/export/google/auth-url', protect, adminOnly, (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ],
    prompt: 'select_account'
  });
  res.json({ url });
});

// @route   POST /api/parts/export/google/token
// @desc    Exchange code for token
// @access  Admin only
router.post('/export/google/token', protect, adminOnly, async (req, res) => {
  try {
    const { code } = req.body;
    const { tokens } = await oauth2Client.getToken(code);
    res.json(tokens);
  } catch (err) {
    res.status(500).json({ message: 'Failed to get token', error: err.message });
  }
});

// @route   POST /api/parts/export/google-sheets
// @desc    Export parts to Google Sheets (using User OAuth or Service Account)
// @access  Admin only
router.post('/export/google-sheets', protect, adminOnly, async (req, res) => {
  let isCancelled = false;
  req.on('close', () => {
    if (!res.writableEnded) {
      isCancelled = true;
      console.log('🛑 Google Sheets Export cancelled.');
    }
  });

  try {
    const { accessToken } = req.body;
    const parts = await Part.find({}).sort({ createdAt: -1 });
    
    let auth;
    if (accessToken) {
      const cleanToken = accessToken.trim();
      const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
      client.setCredentials({ access_token: cleanToken });
      auth = client;
    } else if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
      // Fallback to Service Account
      auth = new google.auth.GoogleAuth({
        credentials: {
          client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else {
      return res.status(400).json({ 
        message: 'Google credentials missing. Please login with Google or provide service account details in .env.' 
      });
    }

    const drive = google.drive({ version: 'v3', auth });
    
    // 1. Initialize Tracker
    exportProgress = { current: 0, total: parts.length, status: 'processing', type: 'Google Sheets' };

    // 2. Generate Excel Workbook (with embedded images)
    const workbook = await buildExcelWorkbook(
      parts,
      (current) => { exportProgress.current = current; },
      () => isCancelled
    );

    if (isCancelled) return;

    // 3. Get Workbook Buffer
    const buffer = await workbook.xlsx.writeBuffer();

    // 4. Search for existing report
    console.log('🔍 Checking for existing report in Google Drive...');
    const searchResponse = await drive.files.list({
      q: "name = 'RE Parts List Report' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    let spreadsheetId;
    const existingFile = searchResponse.data.files?.[0];

    if (existingFile) {
      spreadsheetId = existingFile.id;
      console.log(`🔄 Updating existing report (ID: ${spreadsheetId})...`);
      
      await drive.files.update({
        fileId: spreadsheetId,
        media: {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          body: require('stream').Readable.from(buffer),
        },
      });
    } else {
      console.log('🚀 Creating new report in Google Drive...');
      const response = await drive.files.create({
        requestBody: {
          name: `RE Parts List Report`,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
        media: {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          body: require('stream').Readable.from(buffer),
        },
      });
      spreadsheetId = response.data.id;
    }
    
    // Finalize Tracker
    exportProgress.status = 'idle';

    res.json({ 
      message: 'Exported successfully (Images Embedded)', 
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` 
    });
  } catch (err) {
    console.error('Google Sheets Export Error:', err);
    res.status(500).json({ message: 'Server error during Google Sheets export', error: err.message });
  }
});

module.exports = router;
