const puppeteer = require('puppeteer');
const { google } = require('googleapis');

const SPREADSHEET_ID = '1JJtros9arFArV7MeGasfedQ8cfa1QoKKz8m8EBynYuE';
const SHEET_NAME = '유튜브 댓글';
const START_ROW = 9;
const CREDENTIALS_PATH = './your-credentials.json';
const BLOCK_KEYWORDS = ['상원']; // 여기에 제외 단어 추가
const SHEET_ID = 726863310; // 시트 고유 숫자 ID (필요)

async function getTop5Likes(videoUrl) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(videoUrl, { waitUntil: 'networkidle2' });

  // Shorts 페이지 구조 대응
  const isShorts = videoUrl.includes('/shorts/');

  if (isShorts) {
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) {
        window.scrollBy(0, 500);
        await new Promise(r => setTimeout(r, 1000));
      }
    });
  } else {
    await page.evaluate(async () => {
      for (let i = 0; i < 10; i++) {
        window.scrollBy(0, window.innerHeight);
        await new Promise(r => setTimeout(r, 1000));
      }
    });
  }

  const comments = await page.evaluate(() => {
    const items = document.querySelectorAll('ytd-comment-thread-renderer');
    return Array.from(items).map(el => {
      const text = el.querySelector('#content-text')?.innerText || '';
      const likesText = el.querySelector('#vote-count-middle')?.innerText?.trim() || '0';
      const likes = likesText.includes('천')
        ? parseInt(parseFloat(likesText.replace('천', '')) * 1000)
        : parseInt(likesText.replace(/[^\d]/g, '')) || 0;
      return { text, likes };
    });
  });

  await browser.close();

  return comments
    .filter(c => c.text && c.likes > 0)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 5)
    .map(c => ({
      likes: c.likes,
      isFlagged: BLOCK_KEYWORDS.some(keyword => c.text.includes(keyword))
    }));
}


async function runTasksWithConcurrency(tasks, maxConcurrent) {
  const running = new Set();
  const results = [];

  for (const task of tasks) {
    const p = task().then(result => {
      running.delete(p);
      return result;
    });
    running.add(p);
    results.push(p);

    if (running.size >= maxConcurrent) {
      await Promise.race(running);
    }
  }

  return Promise.all(results);
}

async function runWithRetry(task, retries = 2, delayMs = 5000) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await task();
    } catch (e) {
      console.error(`❌ 시도 ${attempt} 실패: ${e.message}`);
      if (attempt <= retries) {
        console.log(`⏳ ${delayMs / 1000}초 후 재시도...`);
        await new Promise(res => setTimeout(res, delayMs));
      } else {
        console.log('❌ 최대 재시도 횟수를 초과했습니다.');
      }
    }
  }
}

async function run() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!H${START_ROW}:H`
  });

  const rows = res.data.values || [];

  const tasks = rows.map((row, i) => {
    return async () => {
      const baseRow = START_ROW + i;
      const videoUrl = row[0];

      if (!videoUrl || (!videoUrl.includes('youtube.com') && !videoUrl.includes('youtu.be'))) return;

      await runWithRetry(async () => {
        const topLikes = await getTop5Likes(videoUrl);
        const values = topLikes.map(c => [c.likes]);
        const resultRange = `${SHEET_NAME}!L${baseRow}:L${baseRow + 4}`;

        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: resultRange,
          valueInputOption: 'RAW',
          resource: { values }
        });

        const redRowIndexes = topLikes
          .map((c, idx) => (c.isFlagged ? baseRow + idx : null))
          .filter(r => r !== null);

        const requests = redRowIndexes.map(row => ({
          repeatCell: {
            range: {
              sheetId: SHEET_ID,
              startRowIndex: row - 1,
              endRowIndex: row,
              startColumnIndex: 10,
              endColumnIndex: 11
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 1, green: 0.6, blue: 0.6 }
              }
            },
            fields: 'userEnteredFormat.backgroundColor'
          }
        }));

        if (requests.length > 0) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: { requests }
          });
        }

        console.log(`✅ ${baseRow}행 완료: ${values.map(v => v[0]).join(', ')}`);
      });
    };
  });

  console.log(`🚀 총 ${tasks.length}개 영상 병렬 처리 시작...`);
  await runTasksWithConcurrency(tasks, 5); // 동시 최대 5개
  console.log('🎉 모든 유튜브 영상 처리 완료!');
}

run();
