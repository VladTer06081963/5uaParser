import puppeteer from 'puppeteer';
import fs from 'fs';
import cliProgress from 'cli-progress';

// Конфигурация парсера
const config = {
  url: 'https://www.rbc.ru/',
  maxArticles: 10,
  timeout: 60000,
  articleTimeout: 30000,
  outputJsonFile: 'rbc-articles.json',
  outputCsvFile: 'rbc_news_articles.csv',
  maxRetries: 3,
  retryDelay: 1000,
  selectors: {
    articleLinks: 'a[href*="/rbcfreenews/"], a[href*="/society/"], a[href*="/politics/"], a[href*="/economics/"]',
    content: '.article__text, .article__body, .article',
    author: '.article__authors, .article__author',
    tags: '.article__tags a',
    publishedAt: '.article__date, time',
    image: '.article__main-image img, .article__picture img'
  }
};

// Функция задержки
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Функция с повторными попытками
async function tryWithRetry(fn, maxRetries = config.maxRetries, retryDelay = config.retryDelay) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      console.log(`Попытка ${attempt}/${maxRetries} не удалась. Повторяю...`);
      lastError = error;
      await delay(retryDelay);
    }
  }
  
  throw lastError;
}

// Определение категории по URL
function getCategory(url) {
  if (url.includes('/politics/')) return 'Политика';
  if (url.includes('/economics/')) return 'Экономика';
  if (url.includes('/society/')) return 'Общество';
  if (url.includes('/rbcfreenews/')) return 'Срочные новости';
  return 'Новости';
}

// Простой анализ тональности текста
function getTextSentiment(text) {
  const positiveWords = ['рост', 'успех', 'подъем', 'положительный', 'хороший', 'выгод', 'развити'];
  const negativeWords = ['падение', 'снижение', 'кризис', 'проблема', 'конфликт', 'спад', 'риск'];
  
  let positiveScore = 0;
  let negativeScore = 0;
  
  const words = text.toLowerCase().split(/\s+/);
  
  words.forEach(word => {
    if (positiveWords.some(w => word.includes(w))) positiveScore++;
    if (negativeWords.some(w => word.includes(w))) negativeScore++;
  });
  
  return {
    positive: positiveScore,
    negative: negativeScore,
    neutral: words.length - positiveScore - negativeScore,
    sentiment: positiveScore > negativeScore ? 'positive' : 
               negativeScore > positiveScore ? 'negative' : 'neutral'
  };
}

// Логирование ошибок
function logError(message, error, articleUrl = '') {
  console.error(message, error.message);
  fs.appendFileSync('error-log.txt', 
    `\n[${new Date().toISOString()}] ${message} ${articleUrl ? `(URL: ${articleUrl})` : ''}: ${error.message}\n${error.stack}\n`);
}

async function parseRBCWebsite(url = config.url, maxArticles = config.maxArticles) {
  console.log(`Начинаю парсинг сайта: ${url}`);
  
  const browser = await puppeteer.launch({ 
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-notifications',
      '--disable-popup-blocking'
    ]
  });
  
  try {
    const page = await browser.newPage();
    
    // Блокируем рекламу и тяжелый контент
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (
        request.resourceType() === 'image' ||
        request.resourceType() === 'media' ||
        request.resourceType() === 'font' ||
        request.url().includes('advertising') ||
        request.url().includes('analytics') ||
        request.url().endsWith('.css')
      ) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    // Загружаем страницу с повторными попытками
    await tryWithRetry(() => 
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeout })
    );
    
    console.log('Страница загружена');
    
    // Ожидаем появления элементов новостей
    await page.waitForSelector(config.selectors.articleLinks, { timeout: 10000 })
      .catch(() => console.warn('Предупреждение: не удалось дождаться селектора статей'));
    
    // Сохраняем HTML для отладки
    const html = await page.content();
    fs.writeFileSync('debug-rbc.html', html, 'utf8');
    console.log('Сохранен HTML страницы для отладки: debug-rbc.html');

    // Получаем список статей
    const articles = await page.evaluate((selectors) => {
      const articleElements = Array.from(document.querySelectorAll(selectors.articleLinks));
      return articleElements.map(element => ({
        title: element.innerText.trim(),
        url: element.href
      })).filter(article => article.title && article.url);
    }, config.selectors);

    const uniqueArticles = [...new Map(articles.map(item => [item.url, item])).values()];
    const limitedArticles = uniqueArticles.slice(0, maxArticles);
    
    console.log(`Найдено уникальных статей: ${uniqueArticles.length}, обрабатываю первые ${limitedArticles.length}`);

    // Создаем прогресс-бар
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(limitedArticles.length, 0);

    // Параллельная обработка статей
    const detailedArticlesPromises = limitedArticles.map(async (article, index) => {
      // Создаем новую страницу для каждой статьи
      const articlePage = await browser.newPage();
      await articlePage.setRequestInterception(true);
      articlePage.on('request', (request) => {
        if (
          request.resourceType() === 'image' ||
          request.resourceType() === 'media' ||
          request.resourceType() === 'font' ||
          request.url().includes('advertising')
        ) {
          request.abort();
        } else {
          request.continue();
        }
      });
      
      await articlePage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      
      try {
        // Переходим на страницу статьи с повторными попытками
        await tryWithRetry(() => 
          articlePage.goto(article.url, { waitUntil: 'domcontentloaded', timeout: config.articleTimeout })
        );
        
        // Ждем загрузки контента
        await articlePage.waitForSelector(config.selectors.content.split(',')[0], { timeout: 5000 })
          .catch(() => console.warn(`Предупреждение: не удалось дождаться контента для статьи "${article.title}"`));
        
        // Сохраняем HTML статьи для отладки (только для первых трех статей)
        if (index < 3) {
          const articleHtml = await articlePage.content();
          fs.writeFileSync(`debug-rbc-article-${index + 1}.html`, articleHtml, 'utf8');
        }
        
        // Извлекаем информацию
        const details = await articlePage.evaluate((selectors) => {
          const getElementText = selector => {
            const element = document.querySelector(selector);
            return element ? element.innerText.trim() : '';
          };
          
          const getElementAttr = (selector, attr) => {
            const element = document.querySelector(selector);
            return element ? (element.getAttribute(attr) || element.innerText.trim()) : '';
          };
          
          const contentElement = document.querySelector(selectors.content);
          const content = contentElement ? contentElement.innerText.trim() : '';
          
          const authorElement = document.querySelector(selectors.author);
          const author = authorElement ? authorElement.innerText.trim() : 'РБК';
          
          const tags = Array.from(document.querySelectorAll(selectors.tags) || [])
                      .map(tag => tag.innerText.trim());
          
          const publishedAt = getElementAttr(selectors.publishedAt, 'datetime') || 
                             getElementText(selectors.publishedAt);
          
          const imageElement = document.querySelector(selectors.image);
          const imageUrl = imageElement ? imageElement.src : '';
          
          const hasVideo = !!document.querySelector('video, iframe[src*="youtube"]');
          
          return {
            content,
            author,
            tags,
            publishedAt,
            imageUrl,
            hasVideo
          };
        }, config.selectors);
        
        // Закрываем страницу статьи
        await articlePage.close();
        
        // Обновляем прогресс-бар
        progressBar.increment();
        
        // Определяем категорию и анализируем тональность
        const category = getCategory(article.url);
        const sentiment = getTextSentiment(details.content);
        
        return {
          ...article,
          ...details,
          category,
          sentiment,
          parsedAt: new Date().toISOString()
        };
      } catch (error) {
        await articlePage.close();
        logError(`Ошибка при парсинге статьи`, error, article.url);
        
        // Обновляем прогресс-бар даже при ошибке
        progressBar.increment();
        
        return {
          ...article,
          category: getCategory(article.url),
          content: '',
          author: 'РБК',
          tags: [],
          hasVideo: false,
          parsedAt: new Date().toISOString(),
          error: error.message
        };
      }
    });

    // Ожидаем завершения обработки всех статей
    const detailedArticles = await Promise.all(detailedArticlesPromises);
    
    // Останавливаем прогресс-бар
    progressBar.stop();
    
    // Фильтруем статьи без контента
    const validArticles = detailedArticles.filter(article => article.content);
    const invalidArticles = detailedArticles.filter(article => !article.content);
    
    console.log(`Успешно обработано статей: ${validArticles.length}`);
    
    if (invalidArticles.length > 0) {
      console.warn(`Предупреждение: ${invalidArticles.length} статей не содержат контента`);
      fs.writeFileSync('failed-articles.json', JSON.stringify(invalidArticles, null, 2), 'utf8');
    }
    
    return detailedArticles;
    
  } catch (error) {
    logError('Произошла общая ошибка при парсинге', error);
    return [];
  } finally {
    await browser.close();
    console.log('Браузер закрыт');
  }
}

function saveToJson(data, filename = config.outputJsonFile) {
  if (!data || !data.length) {
    console.error('Нет данных для сохранения в JSON');
    return;
  }
  fs.writeFileSync(filename, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Данные сохранены в файл: ${filename}`);
}

function saveToCsv(data, filename = config.outputCsvFile) {
  if (!data || !data.length) {
    console.error('Нет данных для сохранения в CSV');
    return;
  }
  
  // Определяем все возможные заголовки из данных
  const allKeys = new Set();
  data.forEach(item => {
    Object.keys(item).forEach(key => allKeys.add(key));
  });
  
  const headers = Array.from(allKeys);
  
  const rows = data.map(item => 
    headers.map(header => {
      const value = item[header];
      if (value === undefined || value === null) return '""';
      if (typeof value === 'object' && !Array.isArray(value)) {
        return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
      }
      if (Array.isArray(value)) {
        return `"${value.join('; ').replace(/"/g, '""')}"`;
      }
      return `"${String(value).replace(/"/g, '""')}"`;
    }).join(',')
  );
  
  const csvContent = [headers.join(','), ...rows].join('\n');
  fs.writeFileSync(filename, '\ufeff' + csvContent, 'utf8');
  console.log(`Данные сохранены в файл: ${filename}`);
}

// Функция для запуска парсера
async function runParser() {
  console.log(`Начинаем парсинг сайта ${config.url}`);
  console.log(`Дата и время запуска: ${new Date().toLocaleString()}`);
  
  const startTime = Date.now();
  
  try {
    const articles = await parseRBCWebsite();
    
    if (articles && articles.length > 0) {
      saveToJson(articles);
      saveToCsv(articles);
      
      // Сохраняем статистику
      const stats = {
        totalArticles: articles.length,
        articlesWithContent: articles.filter(a => a.content).length,
        articlesWithTags: articles.filter(a => a.tags && a.tags.length > 0).length,
        articlesWithImages: articles.filter(a => a.imageUrl).length,
        articlesWithVideos: articles.filter(a => a.hasVideo).length,
        categoriesCount: Object.entries(
          articles.reduce((acc, article) => {
            acc[article.category] = (acc[article.category] || 0) + 1;
            return acc;
          }, {})
        ),
        sentimentStats: {
          positive: articles.filter(a => a.sentiment && a.sentiment.sentiment === 'positive').length,
          negative: articles.filter(a => a.sentiment && a.sentiment.sentiment === 'negative').length,
          neutral: articles.filter(a => a.sentiment && a.sentiment.sentiment === 'neutral').length,
        },
        executionTimeMs: Date.now() - startTime
      };
      
      console.log('Статистика:');
      console.log(JSON.stringify(stats, null, 2));
      fs.writeFileSync('parsing-stats.json', JSON.stringify(stats, null, 2), 'utf8');
      
      console.log(`Парсинг завершен успешно за ${(stats.executionTimeMs / 1000).toFixed(2)} секунд`);
    } else {
      console.error('Не удалось получить статьи');
    }
  } catch (error) {
    logError('Критическая ошибка при выполнении парсера', error);
    console.error('Парсинг завершен с ошибками');
  }
}

// Запускаем парсер
runParser();