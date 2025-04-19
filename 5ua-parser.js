const puppeteer = require('puppeteer');
const fs = require('fs');

// Универсальная функция ожидания
async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Парсер новостного сайта Meduza.io с фильтрацией по категориям
 * @param {string} url - URL новостного сайта
 * @param {string[]} categories - массив категорий для фильтрации
 * @param {number} maxArticles - максимальное количество статей для парсинга
 * @returns {Promise<Array>} - массив новостных статей
 */
async function parseMeduzaWebsite(url, categories = [], maxArticles = 50) {
  console.log(`Начинаю парсинг сайта: ${url}`);
  console.log(`Фильтр по категориям: ${categories.length ? categories.join(', ') : 'все категории'}`);
  
  const browser = await puppeteer.launch({ 
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    
    // Установка User-Agent для имитации обычного браузера
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36');
    
    // Переход на страницу с более длительным таймаутом
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('Страница загружена');
    
    // Используем универсальную функцию ожидания
    await delay(3000); // 3 секунды ожидания
    
    // Сделаем скриншот для отладки
    await page.screenshot({ path: 'debug-meduza.png' });
    console.log('Создан скриншот для отладки: debug-meduza.png');
    
    // Получаем HTML страницы для отладки
    const pageHtml = await page.content();
    fs.writeFileSync('debug-meduza.html', pageHtml, 'utf8');
    console.log('Сохранен HTML страницы для отладки: debug-meduza.html');
    
    // Получаем все статьи с проверкой разных селекторов
    const articles = await page.evaluate((selectedCategories) => {
      // Эта функция выполняется в контексте браузера
      
      console.log('Начинаем извлечение статей из DOM');
      const allArticles = [];
      
      // Селекторы для Meduza.io
      const selectors = [
        '.NewsBlock-first',   // Первая большая новость
        '.NewsBlock',         // Обычные новостные блоки
        '.NewsCard',          // Карточки новостей
        '.SimpleBlock',       // Простые блоки
        '[data-testid="news-tape-item"]' // Тестовый селектор
      ];
      
      let articleElements = [];
      
      // Пробуем каждый селектор, пока не найдем подходящий
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements && elements.length > 0) {
          console.log(`Найдено ${elements.length} элементов по селектору ${selector}`);
          articleElements = elements;
          break;
        }
      }
      
      if (articleElements.length === 0) {
        console.log('Не удалось найти новостные элементы по известным селекторам');
        
        // Поиск по более общим селекторам
        const possibleContainers = document.querySelectorAll('.NewsTape, .Tape, .Content, main');
        
        // Если нашли контейнер, попробуем найти ссылки внутри него
        if (possibleContainers.length > 0) {
          for (const container of possibleContainers) {
            const links = container.querySelectorAll('a[href*="/news/"], a[href*="/feature/"], a[href*="/story/"]');
            if (links.length > 0) {
              console.log(`Найдено ${links.length} новостных ссылок в контейнере`);
              
              // Собираем данные из найденных ссылок
              for (const link of links) {
                const title = link.innerText.trim() || 'Без названия';
                let category = 'Новости';
                
                // Ищем ближайший элемент с категорией
                const parentElement = link.parentElement;
                if (parentElement) {
                  const categoryEl = parentElement.querySelector('.Tag, .Rubric, [class*="tag"], [class*="rubric"]');
                  if (categoryEl) {
                    category = categoryEl.innerText.trim();
                  }
                }
                
                // Собираем URL
                const url = 'https://meduza.io' + link.getAttribute('href');
                
                // Ищем изображение
                let imageUrl = '';
                const img = parentElement ? parentElement.querySelector('img, .Image, .Media') : null;
                if (img) {
                  imageUrl = img.src || img.getAttribute('data-src') || '';
                }
                
                const article = {
                  title,
                  url,
                  category,
                  imageUrl
                };
                
                // Проверяем, соответствует ли статья выбранным категориям
                const categoryMatches = selectedCategories.length === 0 || 
                  selectedCategories.some(selectedCategory => 
                    article.category.toLowerCase().includes(selectedCategory.toLowerCase())
                  );
                
                if (categoryMatches) {
                  allArticles.push(article);
                }
              }
              
              break; // Если нашли ссылки в контейнере, прекращаем поиск
            }
          }
        }
        
        return allArticles;
      }
      
      // Обработка найденных элементов статей
      for (const element of articleElements) {
        try {
          // Ищем заголовок и ссылку
          let titleElement = element.querySelector('.NewsBlock-title, .NewsCard-title, h2, h3');
          let linkElement = element.querySelector('a[href]');
          
          // Если заголовок внутри ссылки
          if (!titleElement && linkElement) {
            titleElement = linkElement;
          } else if (titleElement && !linkElement) {
            // Если ссылка - это родитель заголовка или весь элемент
            linkElement = titleElement.closest('a') || element.closest('a');
          }
          
          // Поиск категории
          let category = 'Новости';
          const categoryElement = element.querySelector('.Tag, .Rubric, [class*="tag"], [class*="rubric"]');
          if (categoryElement) {
            category = categoryElement.innerText.trim();
          }
          
          // Ищем дату
          const dateElement = element.querySelector('.Timestamp, time, [datetime]');
          
          // Ищем изображение
          const imageElement = element.querySelector('img, .Image, .Media');
          
          // Ищем краткое описание/аннотацию
          const summaryElement = element.querySelector('.NewsBlock-lead, .NewsCard-lead, p');
          
          const article = {
            title: titleElement ? titleElement.innerText.trim() : 'Без названия',
            url: linkElement ? 'https://meduza.io' + linkElement.getAttribute('href') : '',
            category: category,
            date: dateElement ? dateElement.innerText.trim() : '',
            imageUrl: imageElement ? (imageElement.src || imageElement.getAttribute('data-src') || '') : '',
            summary: summaryElement ? summaryElement.innerText.trim() : ''
          };
          
          // Проверяем, соответствует ли статья выбранным категориям
          const categoryMatches = selectedCategories.length === 0 || 
            selectedCategories.some(selectedCategory => 
              article.category.toLowerCase().includes(selectedCategory.toLowerCase())
            );
          
          if (categoryMatches && article.url) {
            allArticles.push(article);
          }
        } catch (error) {
          console.log('Ошибка при обработке элемента:', error);
        }
      }
      
      return allArticles;
    }, categories);
    
    // Ограничиваем количество статей
    const limitedArticles = articles.slice(0, maxArticles);
    console.log(`Найдено статей: ${limitedArticles.length}`);
    
    // Если у нас есть статьи, парсим их детали
    const detailedArticles = [];
    
    for (let i = 0; i < limitedArticles.length; i++) {
      const article = limitedArticles[i];
      console.log(`Обрабатываю статью ${i+1}/${limitedArticles.length}: ${article.title}`);
      
      if (!article.url) {
        detailedArticles.push(article);
        continue;
      }
      
      try {
        // Переходим на страницу статьи
        await page.goto(article.url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Извлекаем подробное содержимое статьи
        const details = await page.evaluate(() => {
          // Селекторы для контента Meduza
          const contentSelectors = [
            '.GeneralMaterial-article', 
            '.RichBlock', 
            '.Material-body',
            'article'
          ];
          
          let contentElement = null;
          for (const selector of contentSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              contentElement = element;
              break;
            }
          }
          
          // Для автора
          const authorElement = document.querySelector('.MaterialNote-authors');
          
          // Получить теги
          const tags = [];
          const tagElements = document.querySelectorAll('.Tags-tag');
          tagElements.forEach(tag => tags.push(tag.innerText.trim()));
          
          // Проверить, есть ли видео в статье
          const hasVideo = !!document.querySelector('.VideoBlock, iframe[src*="youtube"], iframe[src*="vimeo"]');
          
          return {
            content: contentElement ? contentElement.innerText.trim() : '',
            author: authorElement ? authorElement.innerText.trim() : 'Meduza.io',
            tags: tags,
            hasVideo: hasVideo
          };
        });
        
        // Объединяем данные
        detailedArticles.push({
          ...article,
          ...details
        });
        
        // Используем универсальную функцию ожидания
        await delay(2000); // 2 секунды ожидания между запросами
      } catch (error) {
        console.error(`Ошибка при парсинге статьи ${article.url}:`, error.message);
        detailedArticles.push(article);
        continue;
      }
    }
    
    return detailedArticles;
    
  } catch (error) {
    console.error('Произошла ошибка:', error);
    throw error;
  } finally {
    await browser.close();
    console.log('Парсинг завершен');
  }
}

// Остальной код остается без изменений...

/**
 * Функция для парсинга категорий новостей с сайта Meduza.io
 * @param {string} url - URL сайта
 * @returns {Promise<Array>} - массив доступных категорий
 */
async function parseMeduzaCategories(url) {
  console.log(`Получаю список категорий с сайта: ${url}`);
  
  const browser = await puppeteer.launch({ 
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36');
    
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Сделаем скриншот меню для отладки
    await page.screenshot({ path: 'debug-menu-meduza.png' });
    
    // Получаем список категорий с главного меню сайта
    const categories = await page.evaluate(() => {
      const menuSelectors = [
        '.Header-menu a',
        '.Header-tabs a',
        'nav a',
        '[data-testid="menu-item"]'
      ];
      
      let categoryElements = [];
      
      // Пробуем каждый селектор, пока не найдем категории
      for (const selector of menuSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements && elements.length > 0) {
          console.log(`Найдено ${elements.length} элементов меню по селектору ${selector}`);
          categoryElements = Array.from(elements);
          break;
        }
      }
      
      const categories = [];
      
      categoryElements.forEach(element => {
        const href = element.getAttribute('href');
        const text = element.innerText.trim();
        
        if (href && text && 
            !href.includes('http') && 
            href !== '/' && 
            !text.includes('Подписаться') &&
            !text.includes('Поиск')) {
          
          categories.push({
            name: text,
            url: 'https://meduza.io' + (href.startsWith('/') ? href : '/' + href)
          });
        }
      });
      
      return categories;
    });
    
    console.log(`Найдено ${categories.length} категорий`);
    return categories;
    
  } catch (error) {
    console.error('Ошибка при получении категорий:', error);
    return [];
  } finally {
    await browser.close();
  }
}

/**
 * Сохраняет результаты в JSON-файл
 * @param {Array} data - данные для сохранения
 * @param {string} filename - имя файла
 */
function saveToJson(data, filename) {
  fs.writeFileSync(filename, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Данные сохранены в файл: ${filename}`);
}

/**
 * Сохраняет результаты в CSV-файл
 * @param {Array} data - данные для сохранения
 * @param {string} filename - имя файла
 */
function saveToCsv(data, filename) {
  if (!data || data.length === 0) {
    console.error('Нет данных для сохранения в CSV');
    return;
  }
  
  // Формирование корректных заголовков
  const headers = Object.keys(data[0]).join(',');
  
  // Обработка данных для CSV формата
  const rows = data.map(item => 
    Object.values(item)
      .map(value => {
        if (Array.isArray(value)) {
          return `"${value.join('; ').replace(/"/g, '""')}"`;
        }
        return `"${(value || '').toString().replace(/"/g, '""')}"`;
      })
      .join(',')
  );
  
  const csvContent = [headers, ...rows].join('\n');
  fs.writeFileSync(filename, csvContent, 'utf8');
  console.log(`Данные сохранены в файл: ${filename}`);
}

/**
 * Основная функция программы
 */
async function main() {
  const baseUrl = 'https://meduza.io';
  
  try {
    // Сначала получаем список категорий
    const availableCategories = await parseMeduzaCategories(baseUrl);
    console.log('Доступные категории:');
    availableCategories.forEach((cat, index) => {
      console.log(`${index + 1}. ${cat.name} (${cat.url})`);
    });
    
    // Настраиваемые параметры
    const categoriesToFilter = []; // Пустой массив - все категории
    const maxArticlesToParse = 20; // Максимальное количество статей
    
    // Парсим главную страницу
    console.log('\nПарсим главную страницу...');
    const mainPageArticles = await parseMeduzaWebsite(baseUrl, categoriesToFilter, maxArticlesToParse);
    
    if (mainPageArticles && mainPageArticles.length > 0) {
      // Вывод статистики по категориям
      const categoryCounts = {};
      mainPageArticles.forEach(article => {
        const category = article.category;
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      });
      
      console.log('\nСтатистика по категориям:');
      for (const [category, count] of Object.entries(categoryCounts)) {
        console.log(`${category}: ${count} статей`);
      }
      
      // Сохраняем результаты
      saveToJson(mainPageArticles, 'meduza_news_articles.json');
      saveToCsv(mainPageArticles, 'meduza_news_articles.csv');
    } else {
      console.log('\nНе удалось найти статьи на главной странице.');
      
      // Если на главной странице нет статей, попробуем парсить раздел новостей
      const newsUrl = `${baseUrl}/news`;
      console.log(`\nПробуем парсить страницу новостей: ${newsUrl}`);
      const newsArticles = await parseMeduzaWebsite(newsUrl, categoriesToFilter, maxArticlesToParse);
      
      if (newsArticles && newsArticles.length > 0) {
        // Вывод статистики по категориям
        const categoryCounts = {};
        newsArticles.forEach(article => {
          const category = article.category;
          categoryCounts[category] = (categoryCounts[category] || 0) + 1;
        });
        
        console.log('\nСтатистика по категориям:');
        for (const [category, count] of Object.entries(categoryCounts)) {
          console.log(`${category}: ${count} статей`);
        }
        
        // Сохраняем результаты
        saveToJson(newsArticles, 'meduza_news_articles.json');
        saveToCsv(newsArticles, 'meduza_news_articles.csv');
      } else {
        console.log('\nНе удалось найти статьи на странице новостей.');
      }
    }
    
  } catch (error) {
    console.error('Ошибка в основной функции:', error);
  }
}

// Запуск программы
main();
