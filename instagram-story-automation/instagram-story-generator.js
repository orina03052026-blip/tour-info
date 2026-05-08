#!/usr/bin/env node

/**
 * Instagram Story Auto-Posting System
 * 
 * 毎日 0:00 に Google Spreadsheet から「今日・明日の予定」を取得し、
 * Instagram ストーリー用画像を生成して投稿する
 * 
 * 使用方法：
 *   node instagram-story-generator.js                  # 完全実行（画像生成＋投稿）
 *   node instagram-story-generator.js --test           # テスト（画像生成のみ、ローカル保存）
 *   node instagram-story-generator.js --generate-only  # 画像生成のみ
 *   node instagram-story-generator.js --post-only      # 投稿のみ（既存画像使用）
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import axios from 'axios';
import QRCode from 'qrcode';
import { createCanvas, registerFont } from 'canvas';

// ========================================
// グローバル変数・定数
// ========================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODE = {
  FULL: 'full',        // 画像生成 + 投稿
  TEST: 'test',        // 画像生成のみ（ローカル保存）
  GENERATE_ONLY: 'generate-only',
  POST_ONLY: 'post-only'
};

const currentMode = (() => {
  const arg = process.argv[2] || '';
  if (arg === '--test') return MODE.TEST;
  if (arg === '--generate-only') return MODE.GENERATE_ONLY;
  if (arg === '--post-only') return MODE.POST_ONLY;
  return MODE.FULL;
})();

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_GID = process.env.GOOGLE_SHEET_GID || '0';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv&gid=${GOOGLE_SHEET_GID}&t=${Date.now()}`;

const WORDPRESS_URL = process.env.WORDPRESS_URL;
const WORDPRESS_USERNAME = process.env.WORDPRESS_USERNAME;
const WORDPRESS_APP_PASSWORD = process.env.WORDPRESS_APP_PASSWORD;

const INSTAGRAM_BUSINESS_ACCOUNT_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;

const QR_CODE_URL = process.env.QR_CODE_URL || 'https://www.travel-network-act.co.jp/local/en/we-still-have-spots-available-for-our-tours-and-etc/';

const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, '.temp');

const LOG_FILE = path.join(__dirname, `logs-${new Date().toISOString().split('T')[0]}.log');

// ========================================
// ログ出力
// ========================================

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}`;
  console.log(logMessage);
  
  // ログファイルに追記
  try {
    if (!fs.existsSync(path.dirname(LOG_FILE))) {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    }
    fs.appendFileSync(LOG_FILE, logMessage + '\n');
  } catch (e) {
    console.error('Failed to write log file:', e.message);
  }
}

function logError(message, error = null) {
  log(message, 'ERROR');
  if (error) {
    log(`  Error: ${error.message}`, 'ERROR');
    if (error.response?.data) {
      log(`  Response: ${JSON.stringify(error.response.data)}`, 'ERROR');
    }
  }
}

// ========================================
// バリデーション
// ========================================

function validateEnv() {
  const required = [
    'GOOGLE_SHEET_ID',
    'WORDPRESS_URL',
    'WORDPRESS_USERNAME',
    'WORDPRESS_APP_PASSWORD',
    'INSTAGRAM_BUSINESS_ACCOUNT_ID',
    'INSTAGRAM_ACCESS_TOKEN'
  ];
  
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    logError(`Missing environment variables: ${missing.join(', ')}`);
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
  
  log('Environment validation passed');
}

// ========================================
// Google Spreadsheet データ取得
// ========================================

async function fetchGoogleSheetData() {
  log(`Fetching Google Sheet from: ${GOOGLE_SHEET_ID}`);
  
  try {
    const response = await fetch(CSV_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const csv = await response.text();
    log('Successfully fetched CSV data');
    return csv;
  } catch (error) {
    logError('Failed to fetch Google Sheet', error);
    throw error;
  }
}

// ========================================
// CSV パース
// ========================================

function parseCSV(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('Invalid CSV: no data rows');
  }
  
  // ヘッダー解析（日本語対応）
  const header = lines[0].split(',').map(h => h.trim());
  const dateIndex = header.findIndex(h => h.toLowerCase().includes('date'));
  const staffIndex = header.findIndex(h => h.toLowerCase().includes('staff'));
  const timeIndex = header.findIndex(h => h.toLowerCase().includes('time'));
  const tourIndex = header.findIndex(h => h.toLowerCase().includes('tour'));
  const statusIndex = header.findIndex(h => h.toLowerCase().includes('status') || h.toLowerCase().includes('available'));
  const bookedIndex = header.findIndex(h => h.toLowerCase().includes('booked'));
  const capacityIndex = header.findIndex(h => h.toLowerCase().includes('capacity'));
  
  const rows = lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim());
    return {
      date: values[dateIndex] || '',
      staff: values[staffIndex] || '',
      time: values[timeIndex] || '',
      tour: values[tourIndex] || '',
      status: values[statusIndex] || '',
      booked: parseInt(values[bookedIndex]) || 0,
      capacity: parseInt(values[capacityIndex]) || 0
    };
  });
  
  return rows;
}

// ========================================
// 本日・明日のデータ抽出
// ========================================

function getTodayAndTomorrow() {
  const now = new Date();
  
  // 日本時間で今日・明日を計算
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Tokyo'
  });
  
  const todayParts = formatter.formatToParts(now);
  const todayYear = todayParts.find(p => p.type === 'year').value;
  const todayMonth = todayParts.find(p => p.type === 'month').value;
  const todayDay = todayParts.find(p => p.type === 'day').value;
  
  const todayDate = `${todayYear}-${todayMonth}-${todayDay}`;
  
  // 明日の日付
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowParts = formatter.formatToParts(tomorrow);
  const tomorrowYear = tomorrowParts.find(p => p.type === 'year').value;
  const tomorrowMonth = tomorrowParts.find(p => p.type === 'month').value;
  const tomorrowDay = tomorrowParts.find(p => p.type === 'day').value;
  
  const tomorrowDate = `${tomorrowYear}-${tomorrowMonth}-${tomorrowDay}`;
  
  return { todayDate, tomorrowDate };
}

function extractSchedule(rows, todayDate, tomorrowDate) {
  const schedules = {
    today: { date: todayDate, tours: [] },
    tomorrow: { date: tomorrowDate, tours: [] }
  };
  
  rows.forEach(row => {
    if (!row.date || !row.tour) return;
    
    const isToday = row.date === todayDate;
    const isTomorrow = row.date === tomorrowDate;
    
    if (!isToday && !isTomorrow) return;
    
    // 「休み」ステータスをスキップ
    if (row.status.toLowerCase().includes('off') || row.status.toLowerCase().includes('休')) {
      return;
    }
    
    const availableCount = row.capacity - row.booked;
    const tourInfo = {
      name: row.tour,
      staff: row.staff,
      time: row.time,
      available: Math.max(0, availableCount),
      capacity: row.capacity
    };
    
    if (isToday && schedules.today.tours.length < 3) {
      schedules.today.tours.push(tourInfo);
    }
    if (isTomorrow && schedules.tomorrow.tours.length < 3) {
      schedules.tomorrow.tours.push(tourInfo);
    }
  });
  
  return schedules;
}

// ========================================
// QRコード生成
// ========================================

async function generateQRCode(url) {
  try {
    // QRコードを Canvas 互換の形式で生成
    const qrDataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'H',
      type: 'image/png',
      quality: 0.95,
      margin: 1,
      width: 300
    });
    
    log('QR code generated successfully');
    return qrDataUrl;
  } catch (error) {
    logError('Failed to generate QR code', error);
    throw error;
  }
}

// ========================================
// Instagram ストーリー画像生成
// ========================================

async function generateStoryImage(schedules, qrDataUrl) {
  log('Generating Instagram story image...');
  
  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = canvas.getContext('2d');
  
  // 背景：グラデーション（深い青から明るい青）
  const gradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
  gradient.addColorStop(0, '#1a4d7a');
  gradient.addColorStop(0.5, '#2a6fa8');
  gradient.addColorStop(1, '#3a8fd6');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  
  // テキストスタイル設定
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px "Arial", sans-serif';
  ctx.textAlign = 'center';
  
  let yPos = 80;
  
  // ===== タイトル =====
  ctx.font = 'bold 52px "Arial", sans-serif';
  ctx.fillText('Travel Network Act', CANVAS_WIDTH / 2, yPos);
  ctx.font = 'normal 28px "Arial", sans-serif';
  ctx.fillText('@travel_network_act', CANVAS_WIDTH / 2, yPos + 50);
  
  yPos += 130;
  
  // 区切り線
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(100, yPos);
  ctx.lineTo(CANVAS_WIDTH - 100, yPos);
  ctx.stroke();
  
  yPos += 30;
  
  // ===== 本日の予定 =====
  ctx.font = 'bold 36px "Arial", sans-serif';
  ctx.fillStyle = '#ffeb3b';
  ctx.fillText("Today's Schedule", CANVAS_WIDTH / 2, yPos);
  yPos += 50;
  
  ctx.fillStyle = '#ffffff';
  ctx.font = 'normal 24px "Arial", sans-serif';
  
  if (schedules.today.tours.length > 0) {
    schedules.today.tours.forEach(tour => {
      const text = `${tour.name} - ${tour.staff}`;
      ctx.fillText(text, CANVAS_WIDTH / 2, yPos);
      yPos += 40;
      
      const capacity = `Available: ${tour.available}/${tour.capacity}`;
      ctx.font = 'normal 20px "Arial", sans-serif';
      ctx.fillStyle = '#e0e0e0';
      ctx.fillText(capacity, CANVAS_WIDTH / 2, yPos);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'normal 24px "Arial", sans-serif';
      yPos += 35;
    });
  } else {
    ctx.fillStyle = '#b0bec5';
    ctx.fillText('No tours scheduled', CANVAS_WIDTH / 2, yPos);
    yPos += 40;
    ctx.fillStyle = '#ffffff';
  }
  
  yPos += 20;
  
  // 区切り線
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(100, yPos);
  ctx.lineTo(CANVAS_WIDTH - 100, yPos);
  ctx.stroke();
  
  yPos += 30;
  
  // ===== 明日の予定 =====
  ctx.font = 'bold 36px "Arial", sans-serif';
  ctx.fillStyle = '#81c784';
  ctx.fillText("Tomorrow's Schedule", CANVAS_WIDTH / 2, yPos);
  yPos += 50;
  
  ctx.fillStyle = '#ffffff';
  ctx.font = 'normal 24px "Arial", sans-serif';
  
  if (schedules.tomorrow.tours.length > 0) {
    schedules.tomorrow.tours.forEach(tour => {
      const text = `${tour.name} - ${tour.staff}`;
      ctx.fillText(text, CANVAS_WIDTH / 2, yPos);
      yPos += 40;
      
      const capacity = `Available: ${tour.available}/${tour.capacity}`;
      ctx.font = 'normal 20px "Arial", sans-serif';
      ctx.fillStyle = '#e0e0e0';
      ctx.fillText(capacity, CANVAS_WIDTH / 2, yPos);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'normal 24px "Arial", sans-serif';
      yPos += 35;
    });
  } else {
    ctx.fillStyle = '#b0bec5';
    ctx.fillText('No tours scheduled', CANVAS_WIDTH / 2, yPos);
    yPos += 40;
    ctx.fillStyle = '#ffffff';
  }
  
  yPos += 40;
  
  // 区切り線
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(100, yPos);
  ctx.lineTo(CANVAS_WIDTH - 100, yPos);
  ctx.stroke();
  
  // ===== QRコード配置 =====
  yPos += 50;
  
  // QRコード画像を読み込んで Canvas に描画
  const qrImage = await loadImage(qrDataUrl);
  const qrSize = 250;
  ctx.drawImage(qrImage, (CANVAS_WIDTH - qrSize) / 2, yPos, qrSize, qrSize);
  
  yPos += qrSize + 20;
  
  // QRコード説明
  ctx.fillStyle = '#ffffff';
  ctx.font = 'normal 18px "Arial", sans-serif';
  ctx.fillText('Scan to see more details', CANVAS_WIDTH / 2, yPos);
  
  // ===== 保存 =====
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `story-${timestamp}.png`;
  const filepath = path.join(OUTPUT_DIR, filename);
  
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(filepath, buffer);
  
  log(`Story image saved: ${filepath}`);
  return filepath;
}

// Canvas で画像を読み込む（Data URL対応）
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new (require('canvas').Image)();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// ========================================
// WordPress への画像アップロード
// ========================================

async function uploadToWordPress(imagePath) {
  log('Uploading image to WordPress...');
  
  try {
    const fileContent = fs.readFileSync(imagePath);
    const filename = path.basename(imagePath);
    
    const auth = Buffer.from(`${WORDPRESS_USERNAME}:${WORDPRESS_APP_PASSWORD}`).toString('base64');
    
    const response = await axios.post(
      `${WORDPRESS_URL}/wp-json/wp/v2/media`,
      fileContent,
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Type': 'image/png'
        }
      }
    );
    
    const mediaId = response.data.id;
    const mediaUrl = response.data.source_url;
    
    log(`Image uploaded successfully. Media ID: ${mediaId}, URL: ${mediaUrl}`);
    
    return {
      mediaId,
      mediaUrl
    };
  } catch (error) {
    logError('Failed to upload to WordPress', error);
    throw error;
  }
}

// ========================================
// Instagram Graph API への投稿
// ========================================

async function postToInstagram(imageUrl) {
  log('Posting to Instagram Stories...');
  
  try {
    // ステップ1：メディアコンテナを作成
    const createContainerResponse = await axios.post(
      `https://graph.instagram.com/v18.0/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
      {
        image_url: imageUrl,
        media_type: 'STORIES'
      },
      {
        params: {
          access_token: INSTAGRAM_ACCESS_TOKEN
        }
      }
    );
    
    const mediaContainerId = createContainerResponse.data.id;
    log(`Media container created: ${mediaContainerId}`);
    
    // ステップ2：コンテナを公開
    const publishResponse = await axios.post(
      `https://graph.instagram.com/v18.0/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
      {
        creation_id: mediaContainerId
      },
      {
        params: {
          access_token: INSTAGRAM_ACCESS_TOKEN
        }
      }
    );
    
    const postId = publishResponse.data.id;
    log(`Story posted successfully. Post ID: ${postId}`);
    
    return {
      postId,
      postUrl: `https://instagram.com/stories/travel_network_act/${postId}`
    };
  } catch (error) {
    logError('Failed to post to Instagram', error);
    throw error;
  }
}

// ========================================
// メイン処理
// ========================================

async function main() {
  try {
    log(`Starting Instagram Story Auto-Posting (Mode: ${currentMode})`);
    
    // バリデーション（POST_ONLY モード以外）
    if (currentMode !== MODE.POST_ONLY) {
      validateEnv();
    }
    
    let imagePath, uploadResult;
    
    // ===== 画像生成フェーズ =====
    if (currentMode === MODE.FULL || currentMode === MODE.TEST || currentMode === MODE.GENERATE_ONLY) {
      log('Phase 1: Data Retrieval & Image Generation');
      
      // Google Sheet データ取得
      const csvData = await fetchGoogleSheetData();
      const rows = parseCSV(csvData);
      log(`Parsed ${rows.length} rows from CSV`);
      
      // 本日・明日のスケジュール抽出
      const { todayDate, tomorrowDate } = getTodayAndTomorrow();
      log(`Today: ${todayDate}, Tomorrow: ${tomorrowDate}`);
      
      const schedules = extractSchedule(rows, todayDate, tomorrowDate);
      log(`Today tours: ${schedules.today.tours.length}, Tomorrow tours: ${schedules.tomorrow.tours.length}`);
      
      // QRコード生成
      const qrDataUrl = await generateQRCode(QR_CODE_URL);
      
      // ストーリー画像生成
      imagePath = await generateStoryImage(schedules, qrDataUrl);
      
      if (currentMode === MODE.TEST) {
        log('Test mode: image saved locally. Not uploading or posting.');
        log(`Image location: ${imagePath}`);
        return;
      }
      
      if (currentMode === MODE.GENERATE_ONLY) {
        log('Generate-only mode: image generated. Not uploading or posting.');
        return;
      }
      
      // WordPress へアップロード（FULL モード）
      uploadResult = await uploadToWordPress(imagePath);
    }
    
    // ===== 投稿フェーズ =====
    if (currentMode === MODE.FULL || currentMode === MODE.POST_ONLY) {
      log('Phase 2: Instagram Posting');
      
      // POST_ONLY モードの場合、最新の画像URLをここで指定する必要がある
      // 実装時は、前回のアップロード結果を保存・読み込みする仕組みを追加
      if (!uploadResult) {
        logError('No upload result available for POST_ONLY mode');
        throw new Error('POST_ONLY mode requires a previous upload result');
      }
      
      const postResult = await postToInstagram(uploadResult.mediaUrl);
      log(`✅ Story posted successfully!`);
      log(`   Post URL: ${postResult.postUrl}`);
    }
    
    log('✅ All processes completed successfully');
    process.exit(0);
    
  } catch (error) {
    logError('Fatal error in main process', error);
    process.exit(1);
  }
}

// Node.js 実行時のみ
if (process.argv[1] === __filename) {
  main().catch(error => {
    logError('Unhandled error', error);
    process.exit(1);
  });
}

export { main, generateQRCode, generateStoryImage, uploadToWordPress, postToInstagram };
