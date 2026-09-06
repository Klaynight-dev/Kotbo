import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import prisma from '../../utils/db.js';
import { ensureCanvasFonts, canvasFont } from '../../utils/canvasFonts.js';
import { BRAND } from '../../utils/brandPalette.js';
import { xpForLevel, type LevelCurve } from '@kotbo/shared';


// ─────────────────────────────────────────────────────────────
// Shared Canvas Utilities
// ─────────────────────────────────────────────────────────────
function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient, stroke?: string) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

function truncate(str: string, max: number) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function drawBackground(ctx: SKRSContext2D, W: number, H: number) {
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, BRAND.bg1);
  bg.addColorStop(0.5, BRAND.bg2);
  bg.addColorStop(1, BRAND.bg1);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  addChalkboardGrain(ctx, W, H);
}

function addChalkboardGrain(ctx: SKRSContext2D, W: number, H: number) {
  const imageData = ctx.getImageData(0, 0, W, H);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 14;
    data[i] = Math.min(255, Math.max(0, data[i] + noise));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);
}

function drawChalkDust(ctx: SKRSContext2D, W: number, H: number) {
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = Math.random() * 1.5 + 0.3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(232, 228, 217, ${Math.random() * 0.08})`;
    ctx.fill();
  }
}

function drawGlows(ctx: SKRSContext2D, W: number, H: number) {
  drawChalkDust(ctx, W, H);
  const glow1 = ctx.createRadialGradient(W * 0.15, H * 0.12, 0, W * 0.15, H * 0.12, W * 0.4);
  glow1.addColorStop(0, BRAND.glowBlurple);
  glow1.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, W, H);
}

function drawChalkLine(ctx: SKRSContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width: number = 2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  const segments = 12;
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const cx = x1 + (x2 - x1) * t + (Math.random() - 0.5) * 1.5;
    const cy = y1 + (y2 - y1) * t + (Math.random() - 0.5) * 1.5;
    ctx.lineTo(cx, cy);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = 0.7 + Math.random() * 0.3;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawTopAccentBar(ctx: SKRSContext2D, W: number) {
  drawChalkLine(ctx, 20, 6, W - 20, 6, BRAND.chalk, 2.5);
  drawChalkLine(ctx, 20, 6, W - 20, 6, BRAND.chalkDim, 1);
}

function drawBottomBar(ctx: SKRSContext2D, W: number, H: number) {
  drawChalkLine(ctx, 20, H - 6, W - 20, H - 6, BRAND.chalkDim, 2);
}

function drawTapeStrip(ctx: SKRSContext2D, x: number, y: number, w: number, angle: number = 0) {
  ctx.save();
  ctx.translate(x + w / 2, y + 6);
  ctx.rotate(angle * Math.PI / 180);
  ctx.fillStyle = BRAND.tape;
  ctx.fillRect(-w / 2, -6, w, 12);
  ctx.restore();
}

function drawFooter(ctx: SKRSContext2D, W: number, H: number, left: string, right: string) {
  ctx.fillStyle = BRAND.chalkDim;
  ctx.font = canvasFont(12, 'normal');
  ctx.textAlign = 'left';
  ctx.fillText(left, 40, H - 18);
  ctx.textAlign = 'right';
  ctx.fillText(right, W - 40, H - 18);
  ctx.textAlign = 'left';
}

const POST_IT_COLORS = [BRAND.postItYellow, BRAND.postItPink, BRAND.postItBlue, BRAND.postItGreen];
let postItIndex = 0;

function drawKPI(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, value: string, label: string, _color: string) {
  const postItColor = POST_IT_COLORS[postItIndex % POST_IT_COLORS.length];
  postItIndex++;

  const tilt = (Math.random() - 0.5) * 3;
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(tilt * Math.PI / 180);

  // Post-it shadow
  ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 3;
  roundRect(ctx, -w / 2, -h / 2, w, h, 3, postItColor);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Tape on top
  drawTapeStrip(ctx, -18, -h / 2 - 6, 36, tilt * -0.5);

  // Folded corner
  ctx.beginPath();
  ctx.moveTo(w / 2 - 14, h / 2);
  ctx.lineTo(w / 2, h / 2 - 14);
  ctx.lineTo(w / 2, h / 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fill();

  ctx.fillStyle = '#2C2C2C';
  ctx.font = canvasFont(26, 'bold');
  ctx.fillText(value, -w / 2 + 14, 4);

  ctx.fillStyle = '#5A5A5A';
  ctx.font = canvasFont(12, 'normal');
  ctx.fillText(label, -w / 2 + 14, h * 0.32);

  ctx.restore();
}

function drawSeparatorLine(ctx: SKRSContext2D, x: number, y: number, w: number) {
  drawChalkLine(ctx, x, y, x + w, y, BRAND.chalkDim, 1.5);
}

async function drawCircularAvatar(ctx: SKRSContext2D, url: string, x: number, y: number, radius: number, fallbackName?: string) {
  try {
    const img = await loadImage(url);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, x - radius, y - radius, radius * 2, radius * 2);
    ctx.restore();
  } catch {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = BRAND.blurple;
    ctx.fill();
    if (fallbackName) {
      ctx.fillStyle = '#ffffff';
      ctx.font = canvasFont(Math.round(radius), 'bold');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fallbackName.charAt(0).toUpperCase(), x, y);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }
}

// ─────────────────────────────────────────────────────────────
// generateStatsImage - News/RSS Stats
// ─────────────────────────────────────────────────────────────
export async function generateStatsImage(guildId: string): Promise<Buffer> {
  ensureCanvasFonts();
  const W = 1000, H = 650;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, W, H);
  drawGlows(ctx, W, H);
  drawTopAccentBar(ctx, W);

  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);

  const feeds = await prisma.feed.findMany({
    where: { guildId },
    include: { items: { where: { status: 'APPROVED' } }, subscribers: true },
    orderBy: { name: 'asc' },
  });

  const totalApproved = feeds.reduce((s, f) => s + f.items.length, 0);
  const todayApproved = feeds.reduce((s, f) => s + f.items.filter(i => i.createdAt >= today).length, 0);
  const weekApproved = feeds.reduce((s, f) => s + f.items.filter(i => i.createdAt >= weekAgo).length, 0);
  const totalSubs = feeds.reduce((s, f) => s + f.subscribers.length, 0);
  const activeFeeds = feeds.filter(f => f.enabled).length;

  postItIndex = 0;

  // Header
  ctx.fillStyle = BRAND.textPrimary;
  ctx.font = canvasFont(30, 'bold');
  ctx.fillText('Kotbo News - Statistiques', 40, 48);

  ctx.fillStyle = BRAND.textMuted;
  ctx.font = canvasFont(13, 'normal');
  ctx.fillText(now.toLocaleDateString('fr-FR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }), 40, 70);

  drawSeparatorLine(ctx, 40, 84, W - 80);

  // KPIs
  const cards = [
    { label: "Aujourd'hui", value: String(todayApproved), color: BRAND.green },
    { label: 'Cette semaine', value: String(weekApproved), color: BRAND.blurple },
    { label: 'Total validées', value: String(totalApproved), color: BRAND.yellow },
    { label: 'Abonnés DM', value: String(totalSubs), color: BRAND.pink },
    { label: 'Flux actifs', value: `${activeFeeds}/${feeds.length}`, color: BRAND.cyan },
  ];

  const cardW = 168, cardH = 90, cardY = 100, cardGap = 16;
  const totalCardsW = cards.length * cardW + (cards.length - 1) * cardGap;
  const cardStartX = Math.floor((W - totalCardsW) / 2);

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const x = cardStartX + i * (cardW + cardGap);
    drawKPI(ctx, x, cardY, cardW, cardH, c.value, c.label, c.color);
  }

  const sectionY = cardY + cardH + 20;
  drawSeparatorLine(ctx, 40, sectionY, W - 80);

  // Top Feeds Chart
  const chartX = 40, chartY = sectionY + 28, chartW = 560;
  const barH = 26, barGap = 10;

  ctx.fillStyle = BRAND.textSecondary;
  ctx.font = canvasFont(16, 'bold');
  ctx.fillText('Top Flux RSS', chartX, chartY);

  const topFeeds = [...feeds].sort((a, b) => b.items.length - a.items.length).slice(0, 7);
  const maxVal = Math.max(...topFeeds.map(f => f.items.length), 1);

  for (let i = 0; i < topFeeds.length; i++) {
    const feed = topFeeds[i];
    const y = chartY + 22 + i * (barH + barGap);
    const barMaxW = chartW - 200;
    const barW = Math.max(6, (feed.items.length / maxVal) * barMaxW);

    ctx.fillStyle = BRAND.textMuted;
    ctx.font = canvasFont(13, 'normal');
    ctx.fillText(truncate(feed.name, 22), chartX, y + barH - 8);

    roundRect(ctx, chartX + 180, y, barMaxW, barH, 8, 'rgba(255,255,255,0.05)');

    roundRect(ctx, chartX + 180, y, barW, barH, 8, BRAND.chalkDim);

    ctx.fillStyle = BRAND.textPrimary;
    ctx.font = canvasFont(13, 'bold');
    ctx.fillText(String(feed.items.length), chartX + 180 + barW + 10, y + barH - 8);
  }

  // Subscribers Panel
  const rightX = 640, rightY = sectionY + 28;
  roundRect(ctx, rightX - 16, rightY - 16, W - rightX + 16 - 24, 316, 4, BRAND.postItYellow);
  drawTapeStrip(ctx, rightX + 80, rightY - 22, 40, -2);

  ctx.fillStyle = '#3A3A3A';
  ctx.font = canvasFont(16, 'bold');
  ctx.fillText('Abonnés par flux', rightX, rightY);

  const topBySubs = [...feeds].sort((a, b) => b.subscribers.length - a.subscribers.length).slice(0, 8);
  for (let i = 0; i < topBySubs.length; i++) {
    const feed = topBySubs[i];
    const y = rightY + 26 + i * (barH + barGap + 2);

    ctx.fillStyle = '#5A5A5A';
    ctx.font = canvasFont(13, 'normal');
    ctx.fillText(truncate(feed.name, 20), rightX, y + 16);
    const subCount = feed.subscribers.length;
    const dotColor = subCount > 5 ? '#4CAF50' : subCount > 0 ? '#FF9800' : '#9E9E9E';

    ctx.beginPath();
    ctx.arc(rightX + 210, y + 12, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();

    ctx.fillStyle = '#3A3A3A';
    ctx.font = canvasFont(14, 'bold');
    ctx.fillText(String(subCount), rightX + 222, y + 17);
  }

  drawBottomBar(ctx, W, H);
  drawFooter(ctx, W, H, 'Kotbo • RSS & YouTube', `${activeFeeds} flux actifs  •  ${totalApproved} articles`);

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────
// generateWeeklyRecapImage - Terminal-Style Weekly Recap
// ─────────────────────────────────────────────────────────────
export async function generateWeeklyRecapImage(
  guildId: string,
  items: Array<{
    title: string;
    titleTranslated?: string | null;
    interestScore?: number | null;
    feed?: { name?: string | null; category?: string | null } | null;
  }>,
): Promise<Buffer> {
  ensureCanvasFonts();
  const itemX = 50;
  const itemW = 900;
  const itemH = 110;
  const itemGap = 25;
  const headerH = 210;
  const footerH = 60;

  const W = 1000;
  const H = Math.max(600, headerH + items.length * (itemH + itemGap) + footerH);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, W, H);
  drawChalkDust(ctx, W, H);

  // Chalk underline title
  drawChalkLine(ctx, 30, 50, W - 30, 50, BRAND.chalkDim, 2);

  ctx.fillStyle = BRAND.chalk;
  ctx.font = canvasFont(30, 'bold');
  ctx.fillText('Récap hebdo', 50, 80);

  // Hand-drawn arrow
  drawChalkLine(ctx, 340, 72, 380, 72, BRAND.yellow, 2);
  drawChalkLine(ctx, 375, 67, 380, 72, BRAND.yellow, 2);
  drawChalkLine(ctx, 375, 77, 380, 72, BRAND.yellow, 2);

  ctx.fillStyle = BRAND.yellow;
  ctx.font = canvasFont(18, 'bold');
  ctx.fillText('TOP 5', 390, 80);

  ctx.fillStyle = BRAND.chalk;
  ctx.font = canvasFont(28, 'bold');
  ctx.fillText('> WEEKLY RECAP', 50, 140);

  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  ctx.fillStyle = BRAND.textMuted;
  ctx.font = '16px monospace';
  ctx.fillText(`[TIMESTAMP: ${dateStr.toUpperCase()}]`, 50, 170);

  let currentY = headerH;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const y = currentY;
    currentY += itemH + itemGap;

    // Post-it for each item
    const itemColors = [BRAND.postItYellow, BRAND.postItPink, BRAND.postItBlue, BRAND.postItGreen];
    const itemBg = itemColors[i % itemColors.length];
    const itemTilt = (Math.random() - 0.5) * 1.5;

    ctx.save();
    ctx.translate(itemX + itemW / 2, y + itemH / 2);
    ctx.rotate(itemTilt * Math.PI / 180);

    ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    roundRect(ctx, -itemW / 2, -itemH / 2, itemW, itemH, 3, itemBg);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Tape
    drawTapeStrip(ctx, -itemW / 2 + 20, -itemH / 2 - 6, 30, itemTilt * -1);

    // Rank number circled
    ctx.beginPath();
    ctx.arc(-itemW / 2 + 35, 0, 18, 0, Math.PI * 2);
    ctx.strokeStyle = '#3A3A3A';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#2C2C2C';
    ctx.font = canvasFont(22, 'bold');
    ctx.textAlign = 'center';
    ctx.fillText(`${i + 1}`, -itemW / 2 + 35, 7);
    ctx.textAlign = 'left';

    const title = item.titleTranslated ?? item.title;
    ctx.fillStyle = '#2C2C2C';
    ctx.font = canvasFont(18, 'bold');
    ctx.fillText(truncate(title, 60), -itemW / 2 + 70, -8);

    ctx.fillStyle = '#6A6A6A';
    ctx.font = canvasFont(13, 'normal');
    const sourceLabel = `${item.feed?.name ?? '?'} · ${item.feed?.category ?? 'Général'}`;
    ctx.fillText(sourceLabel, -itemW / 2 + 70, 18);

    if (item.interestScore) {
      const score = Math.round(item.interestScore * 100);
      ctx.fillStyle = score > 80 ? '#4CAF50' : score > 50 ? '#FF9800' : '#F44336';
      ctx.font = canvasFont(12, 'bold');
      ctx.fillText(`${score}%`, -itemW / 2 + 70, 38);

      // Hand-drawn underline
      drawChalkLine(ctx, -itemW / 2 + 70, 42, -itemW / 2 + 70 + score * 1.5, 42, ctx.fillStyle as string, 2);
    }

    ctx.restore();
  }

  drawChalkLine(ctx, 30, H - footerH, W - 30, H - footerH, BRAND.chalkDim, 1.5);

  const footerTextY = H - (footerH / 2) + 5;
  ctx.fillStyle = BRAND.chalkDim;
  ctx.font = canvasFont(13, 'normal');
  ctx.textAlign = 'left';
  ctx.fillText(`Kotbo · ${items.length} articles cette semaine`, 50, footerTextY);
  ctx.textAlign = 'right';
  ctx.fillText('Récap hebdo', W - 50, footerTextY);
  ctx.textAlign = 'left';

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────
// generateMemberStatsImage - Member Activity Profile
// ─────────────────────────────────────────────────────────────
export async function generateMemberStatsImage(
  userName: string,
  periodDays: number,
  stats: { totalMessages: number; totalVoice: number; activeDays: number; peakDayMessages: number },
  dailyData: { date: string; messages: number; voice: number }[],
): Promise<Buffer> {
  ensureCanvasFonts();
  const W = 800, H = 520;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, W, H);
  drawGlows(ctx, W, H);
  drawTopAccentBar(ctx, W);
  postItIndex = 0;

  ctx.fillStyle = BRAND.textPrimary;
  ctx.font = canvasFont(26, 'bold');
  ctx.fillText(`Profil d'activité · ${truncate(userName, 24)}`, 40, 46);

  ctx.fillStyle = BRAND.textMuted;
  ctx.font = canvasFont(14, 'normal');
  ctx.fillText(`Les ${periodDays} derniers jours`, 40, 68);

  // KPIs
  const kpis = [
    { label: 'Messages', value: stats.totalMessages.toLocaleString('fr-FR'), color: BRAND.blurple },
    { label: 'Vocal (min)', value: stats.totalVoice.toLocaleString('fr-FR'), color: BRAND.green },
    { label: 'Jours actifs', value: String(stats.activeDays), color: BRAND.yellow },
  ];

  const kpiW = 200, kpiH = 75, kpiGap = 20;
  for (let i = 0; i < kpis.length; i++) {
    const k = kpis[i];
    drawKPI(ctx, 40 + i * (kpiW + kpiGap), 96, kpiW, kpiH, k.value, k.label, k.color);
  }

  // Chart (Shifted right for Y axis labels)
  const chartX = 75, chartY = 210, chartW = W - 115, chartH = 220;
  roundRect(ctx, chartX, chartY, chartW, chartH, 4, 'rgba(255,255,255,0.03)', BRAND.border);

  if (dailyData.length > 0) {
    const maxVal = Math.max(...dailyData.map(d => Math.max(d.messages, d.voice)), 1);
    const pad = 16;

    // Grid lines & Y Axis labels (chalk dashes)
    ctx.fillStyle = BRAND.textMuted;
    ctx.font = canvasFont(10, 'normal');
    ctx.textAlign = 'right';

    for (let i = 0; i < 5; i++) {
      const y = chartY + pad + ((chartH - pad * 2) * i) / 4;
      // Dashed chalk line
      for (let dx = chartX + pad; dx < chartX + chartW - pad; dx += 12) {
        const dashLen = 4 + Math.random() * 4;
        ctx.fillStyle = `rgba(232, 228, 217, ${0.1 + Math.random() * 0.08})`;
        ctx.fillRect(dx, y, dashLen, 1);
      }

      const val = Math.round(maxVal - (maxVal * i) / 4);
      ctx.fillText(val.toLocaleString('fr-FR'), chartX - 10, y + 4);
    }
    ctx.textAlign = 'left';

    // Voice line (chalk green)
    ctx.beginPath();
    for (let i = 0; i < dailyData.length; i++) {
      const x = chartX + pad + i * ((chartW - pad * 2) / (dailyData.length - 1 || 1));
      const y = chartY + chartH - pad - (dailyData[i].voice / maxVal) * (chartH - pad * 2);
      const jx = x + (Math.random() - 0.5) * 1.2;
      const jy = y + (Math.random() - 0.5) * 1.2;
      i === 0 ? ctx.moveTo(jx, jy) : ctx.lineTo(jx, jy);
    }
    ctx.strokeStyle = BRAND.green;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Messages line (chalk blue)
    ctx.beginPath();
    for (let i = 0; i < dailyData.length; i++) {
      const x = chartX + pad + i * ((chartW - pad * 2) / (dailyData.length - 1 || 1));
      const y = chartY + chartH - pad - (dailyData[i].messages / maxVal) * (chartH - pad * 2);
      const jx = x + (Math.random() - 0.5) * 1.2;
      const jy = y + (Math.random() - 0.5) * 1.2;
      i === 0 ? ctx.moveTo(jx, jy) : ctx.lineTo(jx, jy);
    }
    ctx.strokeStyle = BRAND.blurple;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // X Axis month/day labels ("les mois" - ticks)
    ctx.fillStyle = BRAND.textMuted;
    ctx.font = canvasFont(11, 'normal');
    ctx.textAlign = 'center';

    const labelCount = Math.min(5, dailyData.length);
    const labelStep = Math.max(1, Math.floor(dailyData.length / (labelCount - 1)));

    for (let i = 0; i < labelCount; i++) {
      const idx = Math.min(i * labelStep, dailyData.length - 1);
      const dataPoint = dailyData[idx];
      if (dataPoint) {
        const x = chartX + pad + idx * ((chartW - pad * 2) / (dailyData.length - 1 || 1));
        const dateParts = dataPoint.date.split('-');
        if (dateParts.length === 3) {
          const d = new Date(Number(dateParts[0]), Number(dateParts[1]) - 1, Number(dateParts[2]));
          const formattedDate = d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
          ctx.fillText(formattedDate, x, chartY + chartH + 8);
        }
      }
    }
    ctx.textAlign = 'left';

    // Legend (chalk colored)
    roundRect(ctx, chartX + chartW - 200, chartY + 12, 8, 8, 2, BRAND.blurple);
    ctx.fillStyle = BRAND.chalk;
    ctx.font = canvasFont(11, 'normal');
    ctx.fillText('Messages', chartX + chartW - 188, chartY + 20);

    roundRect(ctx, chartX + chartW - 110, chartY + 12, 8, 8, 2, BRAND.green);
    ctx.fillStyle = BRAND.chalk;
    ctx.fillText('Vocal', chartX + chartW - 98, chartY + 20);
  } else {
    ctx.fillStyle = BRAND.textMuted;
    ctx.font = canvasFont(16, 'normal');
    ctx.textAlign = 'center';
    ctx.fillText('Aucune donnée pour cette période', chartX + chartW / 2, chartY + chartH / 2);
    ctx.textAlign = 'left';
  }

  drawBottomBar(ctx, W, H);
  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────
// generateLeaderboardImage - Top 10 Leaderboard
// ─────────────────────────────────────────────────────────────
export async function generateLeaderboardImage(
  topMembers: { name: string; score: number; avatarUrl?: string | null; level?: number }[],
  type: 'messages' | 'voice' | 'mixed' | 'xp',
  periodDays: number,
  curve?: LevelCurve,
): Promise<Buffer> {
  ensureCanvasFonts();
  const W = 720, H = 820;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, W, H);
  drawGlows(ctx, W, H);
  postItIndex = 0;

  const themeColor = type === 'messages' ? BRAND.blurple : type === 'voice' ? BRAND.green : type === 'xp' ? BRAND.pink : BRAND.yellow;

  // Chalk accent line
  drawChalkLine(ctx, 20, 6, W - 20, 6, themeColor, 3);

  // Title
  ctx.fillStyle = BRAND.textPrimary;
  ctx.font = canvasFont(30, 'bold');
  const typeLabel = type === 'messages' ? 'Messages' : type === 'voice' ? 'Vocal' : type === 'xp' ? 'XP & Niveaux' : 'Activité Mixte';
  ctx.fillText(`Top 10 - ${typeLabel}`, 40, 55);

  ctx.fillStyle = BRAND.textMuted;
  ctx.font = canvasFont(15, 'normal');
  const subTitle = type === 'xp' ? "Classement global d'expérience" : `Les ${periodDays} derniers jours`;
  ctx.fillText(subTitle, 40, 80);

  drawSeparatorLine(ctx, 40, 98, W - 80);

  const startY = 116;
  const rowH = 65;
  const maxScore = Math.max(...topMembers.map(m => m.score), 1);

  const rankChalkColors = [BRAND.yellow, BRAND.chalk, '#E8B87E'];

  for (let i = 0; i < topMembers.length; i++) {
    const member = topMembers[i];
    const y = startY + i * rowH;

    // Chalk underline for each row
    drawChalkLine(ctx, 40, y + 54, W - 80, y + 54, BRAND.chalkDim, 0.8);

    // Rank number (hand-drawn circle for top 3)
    if (i < 3) {
      ctx.beginPath();
      ctx.arc(56, y + 27, 16, 0, Math.PI * 2);
      ctx.strokeStyle = rankChalkColors[i];
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.8;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = rankChalkColors[i];
    } else {
      ctx.fillStyle = BRAND.chalkDim;
    }
    ctx.font = canvasFont(16, 'bold');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${i + 1}`, 56, y + 27);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Avatar
    const avatarX = 100, avatarY = y + 27;
    await drawCircularAvatar(ctx, member.avatarUrl || '', avatarX, avatarY, 18, member.name);

    // Level badge first, then name
    let nameStartX = 130;
    if (member.level !== undefined) {
      const lvlText = `Niv.${member.level}`;
      ctx.font = canvasFont(11, 'bold');
      const lvlW = ctx.measureText(lvlText).width + 12;
      roundRect(ctx, nameStartX, y + 12, lvlW, 20, 3, BRAND.postItYellow);
      ctx.fillStyle = '#3A3A3A';
      ctx.font = canvasFont(11, 'bold');
      ctx.fillText(lvlText, nameStartX + 6, y + 26);
      nameStartX += lvlW + 8;
    }
    ctx.fillStyle = BRAND.chalk;
    ctx.font = canvasFont(15, 'bold');
    ctx.fillText(truncate(member.name, 20), nameStartX, y + 27);

    // Chalk bar
    const barX = 340, barMaxW = 200;
    // Sur le classement XP la barre suit la progression dans le niveau en cours,
    // comme la version embed et la carte de rang. La comparer au premier du
    // classement collait les meilleurs à 100 % en permanence, y compris juste
    // après un passage de niveau.
    let ratio: number;
    if (type === 'xp' && member.level !== undefined) {
      const prevXp = xpForLevel(member.level - 1, curve);
      const nextXp = xpForLevel(member.level, curve);
      // Au niveau maximum l'XP monte encore alors que le palier suivant n'existe
      // plus (palier nul) : le ratio est borné, la barre reste pleine.
      const xpNeeded = nextXp - prevXp || 1;
      ratio = Math.min(1, Math.max(0, (member.score - prevXp) / xpNeeded));
    } else {
      ratio = member.score / maxScore;
    }
    const barW = Math.max(6, ratio * barMaxW);

    // Empty bar outline
    for (let dx = barX; dx < barX + barMaxW; dx += 10) {
      ctx.fillStyle = `rgba(232, 228, 217, 0.08)`;
      ctx.fillRect(dx, y + 22, 6, 10);
    }
    // Filled chalk bar
    roundRect(ctx, barX, y + 22, barW, 10, 3, themeColor + 'AA');

    // Score
    ctx.fillStyle = BRAND.textSecondary;
    ctx.font = canvasFont(14, 'bold');
    ctx.textAlign = 'right';
    let scoreFmt: string;
    if (type === 'voice') scoreFmt = `${Math.floor(member.score / 60)}h ${member.score % 60}m`;
    else if (type === 'xp') scoreFmt = `${member.score.toLocaleString('fr-FR')} XP`;
    else scoreFmt = member.score.toLocaleString('fr-FR');
    ctx.fillText(scoreFmt, W - 48, y + 32);
    ctx.textAlign = 'left';
  }

  drawBottomBar(ctx, W, H);
  drawFooter(ctx, W, H, 'Kotbo Analytics', `${topMembers.length} membres classés`);

  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────
// generateServerStatsImage - Server Overview
// ─────────────────────────────────────────────────────────────
export async function generateServerStatsImage(
  guildName: string,
  periodDays: number,
  stats: { totalMessages: number; totalVoice: number; newMembers: number; activeMembers: number; totalMembers: number },
): Promise<Buffer> {
  ensureCanvasFonts();
  const W = 800, H = 480;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, W, H);
  drawGlows(ctx, W, H);
  postItIndex = 0;

  drawChalkLine(ctx, 20, 6, W - 20, 6, BRAND.pink, 3);

  ctx.fillStyle = BRAND.textPrimary;
  ctx.font = canvasFont(28, 'bold');
  ctx.fillText(`Stats Serveur · ${truncate(guildName, 28)}`, 40, 50);

  ctx.fillStyle = BRAND.textMuted;
  ctx.font = canvasFont(15, 'normal');
  ctx.fillText(`Les ${periodDays} derniers jours`, 40, 76);

  drawSeparatorLine(ctx, 40, 92, W - 80);

  // KPIs - 2x2 grid
  const kpis = [
    { label: 'Messages', value: stats.totalMessages.toLocaleString('fr-FR'), color: BRAND.blurple },
    { label: 'Vocal (min)', value: stats.totalVoice.toLocaleString('fr-FR'), color: BRAND.green },
    { label: 'Nouveaux membres', value: `+${stats.newMembers}`, color: BRAND.yellow },
    { label: 'Total membres', value: stats.totalMembers.toLocaleString('fr-FR'), color: BRAND.pink },
  ];

  const kpiW = 340, kpiH = 100, kpiGap = 20;
  for (let i = 0; i < kpis.length; i++) {
    const k = kpis[i];
    const row = Math.floor(i / 2), col = i % 2;
    const x = 40 + col * (kpiW + kpiGap);
    const y = 110 + row * (kpiH + kpiGap);
    drawKPI(ctx, x, y, kpiW, kpiH, k.value, k.label, k.color);
  }

  // Active members status (chalk annotation)
  const statusY = H - 70;
  drawChalkLine(ctx, 40, statusY, W - 40, statusY, BRAND.chalkDim, 1);

  // Hand-drawn arrow pointing to the text
  drawChalkLine(ctx, 42, statusY + 6, 55, statusY + 21, BRAND.green, 2);
  drawChalkLine(ctx, 55, statusY + 21, 50, statusY + 16, BRAND.green, 1.5);

  ctx.fillStyle = BRAND.chalk;
  ctx.font = canvasFont(15, 'bold');
  ctx.fillText(`${stats.activeMembers} membres actifs sur cette période`, 65, statusY + 26);

  drawBottomBar(ctx, W, H);
  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────────────────────
// generateProfileCard - NEW: Rich Profile Card Image
// ─────────────────────────────────────────────────────────────
export async function generateProfileCard(options: {
  displayName: string;
  username: string;
  avatarUrl: string;
  bannerColor?: string;
  bio?: string;
  messageCount: number;
  voiceTime: string;
  level?: number;
  xp?: number;
  rank?: number;
  joinedAt?: string;
  roles: string[];
  streak?: number;
  tier?: string;
  isPrivate?: boolean;
  curve?: LevelCurve;
}): Promise<Buffer> {
  ensureCanvasFonts();
  const W = 934, H = 520;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, W, H);
  drawChalkDust(ctx, W, H);
  postItIndex = 0;

  // Chalk decorative top line
  drawChalkLine(ctx, 20, 12, W - 20, 12, BRAND.chalkDim, 2);
  drawChalkLine(ctx, 20, 16, W - 20, 16, BRAND.chalkDim, 1);

  // Avatar (large, with chalk circle)
  const avatarCX = 100, avatarCY = 100, avatarR = 56;

  // Chalk ring around avatar
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR + 6, 0, Math.PI * 2);
  ctx.strokeStyle = BRAND.chalk;
  ctx.lineWidth = 2.5;
  ctx.globalAlpha = 0.6;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Dark background circle for avatar
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR + 2, 0, Math.PI * 2);
  ctx.fillStyle = BRAND.bg1;
  ctx.fill();

  await drawCircularAvatar(ctx, options.avatarUrl, avatarCX, avatarCY, avatarR, options.displayName);

  // Name & username (chalk text)
  const bannerH = 140;
  const nameX = avatarCX + avatarR + 24;
  ctx.fillStyle = BRAND.chalk;
  ctx.font = canvasFont(28, 'bold');
  ctx.fillText(truncate(options.displayName, 28), nameX, avatarCY - 10);

  ctx.fillStyle = BRAND.chalkDim;
  ctx.font = canvasFont(16, 'normal');
  ctx.fillText(`@${options.username}`, nameX, avatarCY + 14);

  // Tier badge (post-it style)
  if (options.tier) {
    const tierX = nameX + ctx.measureText(`@${options.username}`).width + 16;
    ctx.save();
    ctx.translate(tierX + 20, avatarCY + 6);
    ctx.rotate(-3 * Math.PI / 180);
    roundRect(ctx, -20, -10, ctx.measureText(options.tier).width + 24, 20, 2, BRAND.postItYellow);
    ctx.fillStyle = '#3A3A3A';
    ctx.font = canvasFont(11, 'bold');
    ctx.fillText(options.tier, -12, 4);
    ctx.restore();
  }

  // Rank (chalk, top right, circled)
  if (options.rank) {
    const rankLabel = `#${options.rank}`;
    ctx.font = canvasFont(36, 'bold');

    // Hand-drawn circle around rank
    ctx.beginPath();
    ctx.arc(W - 80, avatarCY - 5, 40, 0, Math.PI * 2);
    ctx.strokeStyle = BRAND.yellow;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = BRAND.chalkDim;
    ctx.font = canvasFont(11, 'bold');
    ctx.textAlign = 'center';
    ctx.fillText('RANG', W - 80, avatarCY - 22);
    ctx.fillStyle = BRAND.chalk;
    ctx.font = canvasFont(30, 'bold');
    ctx.fillText(rankLabel, W - 80, avatarCY + 10);
    ctx.textAlign = 'left';
  }

  // Bio (chalk italic feel)
  const contentY = bannerH + 30;
  if (options.bio) {
    ctx.fillStyle = BRAND.chalkDim;
    ctx.font = canvasFont(14, 'normal');
    ctx.fillText(`« ${truncate(options.bio, 85)} »`, 40, contentY + 12);
  }

  drawSeparatorLine(ctx, 40, contentY + 30, W - 80);

  // Stats Grid (4 cards)
  const statsY = contentY + 48;
  const statCards = [
    { label: 'Messages', value: options.messageCount.toLocaleString('fr-FR'), color: BRAND.blurple },
    { label: 'Vocal', value: options.voiceTime, color: BRAND.green },
    { label: 'Niveau', value: options.level !== undefined ? String(options.level) : '-', color: BRAND.pink },
    { label: 'Streak', value: options.streak !== undefined ? `${options.streak}j` : '-', color: BRAND.yellow },
  ];

  const statW = 195, statH = 72, statGap = 16;
  const totalStatsW = statCards.length * statW + (statCards.length - 1) * statGap;
  const statStartX = Math.floor((W - totalStatsW) / 2);

  for (let i = 0; i < statCards.length; i++) {
    const s = statCards[i];
    const x = statStartX + i * (statW + statGap);
    drawKPI(ctx, x, statsY, statW, statH, s.value, s.label, s.color);
  }

  // XP Progress (if available)
  if (options.xp !== undefined && options.level !== undefined) {
    const xpBarY = statsY + statH + 20;
    const xpBarX = 40, xpBarW = W - 80, xpBarH = 14;

    const prevXp = xpForLevel(options.level - 1, options.curve);
    const nextXp = xpForLevel(options.level, options.curve);
    const progress = Math.min(1, Math.max(0, (options.xp - prevXp) / (nextXp - prevXp || 1)));

    roundRect(ctx, xpBarX, xpBarY, xpBarW, xpBarH, 4, 'rgba(255,255,255,0.06)');
    if (progress > 0) {
      const filledW = Math.max(xpBarH, xpBarW * progress);
      roundRect(ctx, xpBarX, xpBarY, filledW, xpBarH, 4, BRAND.chalk + 'AA');
    }

    ctx.fillStyle = BRAND.textMuted;
    ctx.font = canvasFont(12, 'bold');
    ctx.fillText(`Niv. ${options.level}`, xpBarX, xpBarY + xpBarH + 16);
    ctx.textAlign = 'right';
    const xpNeeded = nextXp - prevXp || 1;
    // Bornée au palier : au niveau maximum d'une guilde plafonnée, l'XP monte
    // encore alors que le palier suivant n'existe plus.
    const xpInLevel = Math.min(Math.max(0, options.xp - prevXp), xpNeeded);
    ctx.fillText(`${xpInLevel.toLocaleString('fr-FR')} / ${xpNeeded.toLocaleString('fr-FR')} XP`, xpBarX + xpBarW, xpBarY + xpBarH + 16);
    ctx.textAlign = 'left';
  }

  // Roles (bottom section - chalk tags)
  if (options.roles.length > 0) {
    const rolesY = H - 75;
    ctx.fillStyle = BRAND.chalkDim;
    ctx.font = canvasFont(12, 'bold');
    ctx.fillText('Rôles', 40, rolesY);

    // Chalk underline under "Rôles"
    drawChalkLine(ctx, 40, rolesY + 4, 80, rolesY + 4, BRAND.chalkDim, 1);

    let roleX = 40;
    const maxRoles = 8;
    const roleColors = [BRAND.postItYellow, BRAND.postItPink, BRAND.postItBlue, BRAND.postItGreen];
    for (let i = 0; i < Math.min(options.roles.length, maxRoles); i++) {
      const role = options.roles[i];
      ctx.font = canvasFont(11, 'normal');
      const rw = ctx.measureText(truncate(role, 16)).width + 16;
      const tilt = (Math.random() - 0.5) * 4;
      ctx.save();
      ctx.translate(roleX + rw / 2, rolesY + 19);
      ctx.rotate(tilt * Math.PI / 180);
      roundRect(ctx, -rw / 2, -11, rw, 22, 2, roleColors[i % roleColors.length]);
      ctx.fillStyle = '#3A3A3A';
      ctx.font = canvasFont(11, 'normal');
      ctx.fillText(truncate(role, 16), -rw / 2 + 8, 4);
      ctx.restore();
      roleX += rw + 6;
      if (roleX > W - 100) break;
    }
    if (options.roles.length > maxRoles) {
      ctx.fillStyle = BRAND.chalkDim;
      ctx.font = canvasFont(11, 'bold');
      ctx.fillText(`+${options.roles.length - maxRoles}`, roleX + 4, rolesY + 23);
    }
  }

  // Joined at
  if (options.joinedAt) {
    ctx.fillStyle = BRAND.chalkDim;
    ctx.font = canvasFont(11, 'normal');
    ctx.textAlign = 'right';
    ctx.fillText(`Membre depuis ${options.joinedAt}`, W - 40, H - 16);
    ctx.textAlign = 'left';
  }

  // Branding
  ctx.fillStyle = BRAND.chalkDim;
  ctx.font = canvasFont(11, 'normal');
  ctx.fillText('Kotbo · Profil communautaire', 40, H - 16);

  drawBottomBar(ctx, W, H);
  return canvas.toBuffer('image/png');
}
