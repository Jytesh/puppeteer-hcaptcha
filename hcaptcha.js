const puppeteer = require("puppeteer-extra");
const pluginStealth = require("puppeteer-extra-plugin-stealth");
const got = require("got");
const userAgents = JSON.parse(require('fs').readFileSync('./src/useragents.json'));
const vm = require('vm');
const { rdn, getMouseMovements, rdntf } = require("./src/utils");
require("@google-cloud/vision");

// Setup Google Vision Client
let client;

puppeteer.use(pluginStealth());

let hslFile = got('https://assets.hcaptcha.com/c/58296b80/hsl.js').then(x => x.body);
async function getHSL(req) {
  const hsl = await hslFile;
  return new Promise((resolve, reject) => {
    const code = `
    var self = {};
    function atob(a) {
      return new Buffer.from(a, 'base64').toString('binary');
    }
  
    ${hsl}
  
    hsl('${req}').then(resolve).catch(reject)
    `;
    vm.runInNewContext(code, {
      Buffer,
      resolve,
      reject,
    });
  });
}

async function getVisionClientAnswers(tasks, request_image) {
  let answers = new Map();
  for (const task of tasks) {
    await client.objectLocalization(task.datapoint_uri).then((res) => {
      let [data] = res;
      if (data.localizedObjectAnnotations.find((i) => i.name.toUpperCase() === request_image.toUpperCase() && i.score > 0.5)) {
        answers[task.task_key] = "true";
      } else {
        answers[task.task_key] = "false";
      }
    });
  }

  return answers;
}

function getRandomAnswers(tasks) {
  let answers = new Map();
  for (const task of tasks)
    answers[task.task_key] = rdntf()
  return answers;
}

async function tryToSolve(userAgent, sitekey, host, getAnswers) {
  // Create headers
  let headers = {
    "Authority": "hcaptcha.com",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://assets.hcaptcha.com",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "User-Agent": userAgent
  };
  
  // Check site config
  let response = await get({
    headers,
    url: `https://hcaptcha.com/checksiteconfig?host=${host}&sitekey=${sitekey}&sc=1&swa=1`
  });

  let timestamp = Date.now() + rdn(30, 120);

  // Check for HSJ/HSW
  if (response.c.type !== "hsl") {
    console.error('Wrong Challenge Type. Retrying.');
    return null;
  }
  
  // Setup form for getting tasks list 
  if (response.c === undefined) {
    form = {
      sitekey,
      host,
      hl: 'en',
      motionData: {
        st: timestamp,
        mm: getMouseMovements(timestamp)
      },
    }
  } else {
    form = {
      sitekey,
      host,
      hl: 'en',
      motionData: {
        st: timestamp,
        mm: getMouseMovements(timestamp)
      },
      n: await getHSL(response.c.req),
      c: JSON.stringify(response.c)
    }
  }

  // Get tasks
  let getTasks = await get({
    method: "post",
    headers,
    url: `https://hcaptcha.com/getcaptcha`,
    form: form
  });

  if (getTasks.generated_pass_UUID) {
    return getTasks.generated_pass_UUID;
  }

  // Find what the captcha is looking for user's to click
  const requestImageArray = getTasks.requester_question.en.split(" ");
  let request_image = requestImageArray[requestImageArray.length - 1];
  if (request_image === "motorbus") {
    request_image = "bus"
  } else {
    request_image = requestImageArray[requestImageArray.length - 1];
  }

  const key = getTasks.key;
  if (key.charAt(2) === "_") {
    return key;
  }

  const tasks = getTasks.tasklist;
  const job = getTasks.request_type;
  timestamp = Date.now() + rdn(30, 120);

  // Get Answers
  const answers = await getAnswers(tasks, request_image);

  // Renew response
  response = await get({
    headers,
    url: `https://hcaptcha.com/checksiteconfig?host=${host}&sitekey=${sitekey}&sc=1&swa=1`
  });

  // Setup data for checking answers
  if (response.c === undefined) {
    captchaResponse = {
      job_mode: job,
      answers,
      serverdomain: host,
      sitekey,
      motionData: JSON.stringify({
        st: timestamp,
        dct: timestamp,
        mm: getMouseMovements(timestamp),
      }),
      n: null,
      c: "null",
    }
  } else {
    captchaResponse = {
      job_mode: job,
      answers,
      serverdomain: host,
      sitekey,
      motionData: JSON.stringify({
        st: timestamp,
        dct: timestamp,
        mm: getMouseMovements(timestamp),
      }),
      n: await getHSL(response.c.req),
      c: JSON.stringify(response.c)
    }
  }

  // Set new headers
  headers = {
    "Authority": "hcaptcha.com",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    "Origin": "https://assets.hcaptcha.com",
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "User-Agent": userAgent,
  };

  // Check answers
  const checkAnswers = await get(`https://hcaptcha.com/checkcaptcha/${key}`, {
    method: "post",
    headers,
    json: captchaResponse,
  });

  if (checkAnswers.generated_pass_UUID) {
    return checkAnswers.generated_pass_UUID;
  }

  console.error('Wrong Response. Retrying.');
  return null;
}

async function solveCaptcha(siteKey, host, getAnswers) {
  try {
    while (true) {
      // Get random index for random user agent
      const randomIndex = Math.round(Math.random() * ((userAgents.length - 1) - 0) + 0)

      // Attempt to solve hCaptcha
      const result = await tryToSolve(userAgents[randomIndex].useragent, siteKey, host, getAnswers);
      if (result && result !== null) {
        return result;
      }
    }
  } catch (e) {
    if (e.statusCode === 429) {
      // Reached rate limit, wait 30 sec
      console.log('Rate limited. Waiting 30 seconds.');
      await new Promise((r) => setTimeout(r, 30000));
    } else {
      throw e;
    }
  }
}

async function hcaptcha(page, visionClient) {
  let strategy = getVisionClientAnswers;

  if (!visionClient)
    strategy = getRandomAnswers
  else 
    // Set client passed in to Google Client
    client = await visionClient;

  // Expose the page to our solveCaptcha function so we can utilize it
  await page.exposeFunction("solveCaptcha", solveCaptcha);

  // Wait for iframe to load
  await page.waitForSelector('iframe[src*="assets.hcaptcha.com"]');

  const token = await page.evaluate(async () => {
    // Get hcaptcha iframe so we can get the host value
    const iframesrc = document.querySelector(
      'iframe[src*="assets.hcaptcha.com"]'
    ).src;
    const urlParams = new URLSearchParams(iframesrc);

    return await solveCaptcha(
      urlParams.get("sitekey"),
      urlParams.get("host"), strategy
    );
  });

  await page.evaluate((token) => {
    document.querySelector('[name="h-captcha-response"]').value = token;
    document.querySelector('[name="g-recaptcha-response"]').value = token;
  }, token)

  return;
}

async function hcaptchaToken(url, visionClient, options) {
  let strategy = getVisionClientAnswers;
  // Set client passed in to Google Client
  if (!visionClient) {
    strategy = getRandomAnswers;
  }
  else
    client = await visionClient;

  const captchaData = options || await getSiteConfig(url);
  // Solve Captcha  
  return await solveCaptcha(captchaData[0], captchaData[1], strategy);
}

async function getSiteConfig(url) {
  const browser = await puppeteer.launch({
    ignoreHTTPSErrors: true,
    headless: true,
  });

  // Get browser pages
  const [page] = await browser.pages();
  await page.goto(url)
  await page.setDefaultNavigationTimeout(0);

  // Wait for iframe to load
  await page.waitForSelector('iframe[src*="assets.hcaptcha.com"]');

  let captchaData = await page.evaluate(async () => {
    // Get hcaptcha iframe so we can get the host value
    const iframesrc = document.querySelector(
      'iframe[src*="assets.hcaptcha.com"]'
    ).src;
    const urlParams = new URLSearchParams(iframesrc);

    return [urlParams.get('sitekey'), urlParams.get('host')];
  });

  await browser.close();
  return captchaData;
}
const instance = got.extend({
  responseType: 'json', resolveBodyOnly: true
})
const get = (...args) => instance(...args).catch(err => {
  console.error(err);
  throw err;
})

/*
.then(x => {
  console.log(...args, x);
  return x;
})
*/

module.exports = { hcaptcha, hcaptchaToken, getSiteConfig };