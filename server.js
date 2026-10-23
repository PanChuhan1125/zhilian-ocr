import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT) || 3000;

const BAIDU_API_KEY =
  process.env.BAIDU_API_KEY || process.env.BAIDU_OCR_API_KEY || "";

const BAIDU_SECRET_KEY =
  process.env.BAIDU_SECRET_KEY || process.env.BAIDU_OCR_SECRET_KEY || "";

const ZHIPU_API_KEY =
  process.env.ZHIPU_API_KEY || process.env.ZHIPUAI_API_KEY || "";

const ZHIPU_MODEL = process.env.ZHIPU_MODEL || "glm-4-flash";

const BAIDU_TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const BAIDU_OCR_URL =
  "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic";
const ZHIPU_CHAT_URL =
  "https://open.bigmodel.cn/api/paas/v4/chat/completions";

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
});

const baiduTokenCache = {
  accessToken: "",
  expiresAt: 0,
};

function sendError(response, status, message, details) {
  const body = {
    success: false,
    error: message,
  };

  if (details) {
    body.details = String(details);
  }

  response.status(status).json(body);
}

async function readJsonResponse(response, serviceName) {
  const responseText = await response.text();
  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `${serviceName}返回了无法解析的内容：${responseText.slice(0, 300)}`,
    );
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.error_msg ||
      data?.message ||
      response.statusText;

    throw new Error(
      `${serviceName}请求失败（${response.status}）：${message}`,
    );
  }

  return data;
}

async function getBaiduAccessToken() {
  if (
    baiduTokenCache.accessToken &&
    Date.now() < baiduTokenCache.expiresAt
  ) {
    return baiduTokenCache.accessToken;
  }

  if (!BAIDU_API_KEY || !BAIDU_SECRET_KEY) {
    throw new Error(
      "百度 OCR 密钥未配置，请填写 BAIDU_API_KEY 和 BAIDU_SECRET_KEY。",
    );
  }

  const tokenUrl = new URL(BAIDU_TOKEN_URL);
  tokenUrl.searchParams.set("grant_type", "client_credentials");
  tokenUrl.searchParams.set("client_id", BAIDU_API_KEY);
  tokenUrl.searchParams.set("client_secret", BAIDU_SECRET_KEY);

  const response = await fetch(tokenUrl, {
    method: "POST",
    signal: AbortSignal.timeout(20000),
  });

  const data = await readJsonResponse(response, "百度 OCR 鉴权接口");

  if (!data.access_token) {
    throw new Error(
      data.error_description || "百度接口没有返回 access_token。",
    );
  }

  const expiresInSeconds = Number(data.expires_in) || 2592000;

  baiduTokenCache.accessToken = data.access_token;
  baiduTokenCache.expiresAt =
    Date.now() + Math.max(expiresInSeconds - 300, 60) * 1000;

  return data.access_token;
}

function extractJsonCandidate(rawContent) {
  const source = String(rawContent || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .replace(/^\uFEFF/, "")
    .trim();

  const startIndex = source.search(/[\[{]/);

  if (startIndex === -1) {
    return "";
  }

  const stack = [];
  let insideString = false;
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\" && insideString) {
      escaped = true;
      continue;
    }

    if (character === '"') {
      insideString = !insideString;
      continue;
    }

    if (insideString) {
      continue;
    }

    if (character === "{" || character === "[") {
      stack.push(character === "{" ? "}" : "]");
      continue;
    }

    if (character === "}" || character === "]") {
      if (stack.pop() !== character) {
        return "";
      }

      if (stack.length === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return "";
}

function removeTrailingCommas(jsonText) {
  let result = "";
  let insideString = false;
  let escaped = false;

  for (let index = 0; index < jsonText.length; index += 1) {
    const character = jsonText[index];

    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }

    if (character === "\\" && insideString) {
      result += character;
      escaped = true;
      continue;
    }

    if (character === '"') {
      insideString = !insideString;
      result += character;
      continue;
    }

    if (character === "," && !insideString) {
      let nextIndex = index + 1;

      while (
        nextIndex < jsonText.length &&
        /\s/.test(jsonText[nextIndex])
      ) {
        nextIndex += 1;
      }

      if (
        jsonText[nextIndex] === "}" ||
        jsonText[nextIndex] === "]"
      ) {
        continue;
      }
    }

    result += character;
  }

  return result;
}

function replaceStructuralPunctuation(jsonText) {
  const replacements = {
    "：": ":",
    "，": ",",
    "｛": "{",
    "｝": "}",
    "［": "[",
    "］": "]",
  };

  let result = "";
  let insideString = false;
  let escaped = false;

  for (const character of jsonText) {
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }

    if (character === "\\" && insideString) {
      result += character;
      escaped = true;
      continue;
    }

    if (character === '"') {
      insideString = !insideString;
      result += character;
      continue;
    }

    if (!insideString && replacements[character]) {
      result += replacements[character];
      continue;
    }

    result += character;
  }

  return result;
}

function parseModelJson(rawContent) {
  const candidate =
    extractJsonCandidate(rawContent) || String(rawContent || "").trim();

  if (!candidate) {
    throw new Error("模型没有返回 JSON 内容。");
  }

  const withoutTrailingCommas = removeTrailingCommas(candidate);
  const structuralPunctuation =
    replaceStructuralPunctuation(withoutTrailingCommas);

  const attempts = [
    candidate,
    withoutTrailingCommas,
    structuralPunctuation,
    structuralPunctuation
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'"),
  ];

  let lastError;

  for (const attempt of new Set(attempts)) {
    try {
      return JSON.parse(attempt);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `模型返回的 JSON 无法解析：${lastError?.message || "未知错误"}`,
  );
}

function getMessageContent(data) {
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        return part?.text || part?.content || "";
      })
      .join("");
  }

  return "";
}

function normalizeOption(option) {
  if (typeof option === "string" || typeof option === "number") {
    return String(option).trim();
  }

  if (option && typeof option === "object") {
    return String(
      option.text ||
        option.label ||
        option.value ||
        option.content ||
        "",
    ).trim();
  }

  return "";
}

function resolveAnswer(answerValue, options) {
  if (typeof answerValue === "number") {
    return options[answerValue] || "";
  }

  const answer = String(answerValue ?? "").trim();

  if (!answer) {
    return "";
  }

  if (options.includes(answer)) {
    return answer;
  }

  const letterMatch = answer.match(/^[（(]?([A-Za-z])[）).、:：]?/);

  if (letterMatch) {
    const index = letterMatch[1].toUpperCase().charCodeAt(0) - 65;

    if (index >= 0 && index < options.length) {
      return options[index];
    }
  }

  const numberMatch = answer.match(/^\d+$/);

  if (numberMatch) {
    const index = Number(answer) - 1;

    if (index >= 0 && index < options.length) {
      return options[index];
    }
  }

  return "";
}

function normalizeQuestion(rawQuestion, mode) {
  if (!rawQuestion || typeof rawQuestion !== "object") {
    return null;
  }

  const question = String(
    rawQuestion.question ||
      rawQuestion.stem ||
      rawQuestion.title ||
      "",
  ).trim();

  const rawOptions =
    rawQuestion.options ||
    rawQuestion.choices ||
    rawQuestion.candidates ||
    [];

  const options = Array.isArray(rawOptions)
    ? rawOptions.map(normalizeOption).filter(Boolean)
    : [];

  const rawAnswer =
    rawQuestion.answer ??
    rawQuestion.correctAnswer ??
    rawQuestion.correct_answer ??
    rawQuestion.correctOption ??
    rawQuestion.answerIndex ??
    (Array.isArray(rawQuestion.answers) ? rawQuestion.answers[0] : "");

  const answer = resolveAnswer(rawAnswer, options);
  const uniqueOptions = [...new Set(options)];

  if (!question || !answer) {
    return null;
  }

  if (mode === "fill") {
    if (uniqueOptions.length < 3 || !uniqueOptions.includes(answer)) {
      return null;
    }

    let finalOptions = uniqueOptions;

    if (finalOptions.length > 3) {
      finalOptions = [
        answer,
        ...uniqueOptions.filter((option) => option !== answer).slice(0, 2),
      ];
    }

    return {
      question,
      options: finalOptions,
      answer,
      answers: [answer],
      answerIndex: finalOptions.indexOf(answer),
    };
  }

  if (uniqueOptions.length !== 4 || !uniqueOptions.includes(answer)) {
    return null;
  }

  return {
    question,
    options: uniqueOptions,
    answer,
    answers: [answer],
    answerIndex: uniqueOptions.indexOf(answer),
  };
}

function buildPrompt(text, mode) {
  if (mode === "fill") {
    return `你是一名严谨的中文阅读理解命题老师。

请根据下面的原文生成 10 道“选词填空题”。

规则：
1. 每道题只挖一个空，空格必须写成 ___。
2. 每道题提供 3 个互不相同的选项。
3. 3 个选项中只有 1 个正确答案，另外 2 个是干扰项。
4. answer 必须与 options 中的正确选项字符串完全一致，不能填写 A/B/C。
5. 只能使用原文能够支持的内容出题。
6. 只输出合法 JSON 数组，不要输出 Markdown、代码围栏或解释文字。
7. 如果原文太短，至少生成 1 道有效题目。

严格使用以下 JSON 结构：
[
  {
    "question": "因流行于盛唐至___时期故称唐三彩。",
    "options": ["前唐", "中唐", "后唐"],
    "answer": "中唐"
  }
]

原文：
${text}`;
  }

  return `你是一名严谨的中文阅读理解命题老师。

请根据下面的原文生成 10 道“单项选择题”。

规则：
1. 每道题必须提供 4 个互不相同的选项。
2. 4 个选项中只有 1 个正确答案。
3. answer 必须与 options 中的正确选项字符串完全一致，不能填写 A/B/C/D。
4. 题目必须能够直接由原文判断。
5. 只输出合法 JSON 数组，不要输出 Markdown、代码围栏或解释文字。
6. 如果原文太短，至少生成 1 道有效题目。

严格使用以下 JSON 结构：
[
  {
    "question": "唐三彩主要流行于哪个时期？",
    "options": ["盛唐至中唐", "春秋时期", "西汉时期", "北宋时期"],
    "answer": "盛唐至中唐"
  }
]

原文：
${text}`;
}

async function requestQuestionsFromZhipu(text, mode) {
  if (!ZHIPU_API_KEY) {
    throw new Error("智谱 API Key 未配置，请填写 ZHIPU_API_KEY。");
  }

  const response = await fetch(ZHIPU_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ZHIPU_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ZHIPU_MODEL,
      messages: [
        {
          role: "system",
          content:
            "你只负责生成结构化 JSON 题目，严格遵守字段名和值域。",
        },
        {
          role: "user",
          content: buildPrompt(text, mode),
        },
      ],
      temperature: 0.35,
      top_p: 0.8,
      max_tokens: 6000,
      stream: false,
    }),
    signal: AbortSignal.timeout(90000),
  });

  const data = await readJsonResponse(response, "智谱接口");
  const content = getMessageContent(data);

  if (!content) {
    throw new Error("智谱接口没有返回 message.content。");
  }

  return parseModelJson(content);
}

app.get("/health", (_request, response) => {
  response.json({
    success: true,
    message: "服务运行正常。",
    model: ZHIPU_MODEL,
  });
});

app.post("/api/ocr", upload.any(), async (request, response) => {
  const imageFile = Array.isArray(request.files)
    ? request.files.find((file) => file.mimetype.startsWith("image/"))
    : null;

  if (!imageFile) {
    sendError(response, 400, "没有收到图片文件。");
    return;
  }

  try {
    const accessToken = await getBaiduAccessToken();

    const ocrUrl = new URL(BAIDU_OCR_URL);
    ocrUrl.searchParams.set("access_token", accessToken);

    const requestBody = new URLSearchParams();
    requestBody.set("image", imageFile.buffer.toString("base64"));

    const ocrResponse = await fetch(ocrUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: requestBody,
      signal: AbortSignal.timeout(45000),
    });

    const ocrData = await readJsonResponse(ocrResponse, "百度 OCR");

    if (ocrData.error_code) {
      throw new Error(
        ocrData.error_msg ||
          `百度 OCR 错误码：${ocrData.error_code}`,
      );
    }

    const wordsResult = Array.isArray(ocrData.words_result)
      ? ocrData.words_result
      : [];

    const text = wordsResult
      .map((item) => String(item?.words || "").trim())
      .filter(Boolean)
      .join("\n");

    if (!text) {
      sendError(
        response,
        422,
        "图片已识别，但没有检测到文字。请换一张更清晰的图片。",
      );
      return;
    }

    response.json({
      success: true,
      text,
      words_result: wordsResult,
      words_result_num:
        Number(ocrData.words_result_num) || wordsResult.length,
      result: {
        text,
        words_result: wordsResult,
      },
    });
  } catch (error) {
    console.error("[OCR ERROR]", error);

    sendError(
      response,
      500,
      error instanceof Error ? error.message : "OCR 识别失败。",
    );
  }
});

app.post("/api/generate-questions", async (request, response) => {
  const text = String(request.body?.text || "").trim();

  const requestedMode = String(
    request.body?.mode ||
      request.body?.type ||
      request.body?.questionType ||
      "choice",
  )
    .trim()
    .toLowerCase();

  const mode = ["fill", "blank", "填空"].includes(requestedMode)
    ? "fill"
    : "choice";

  if (!text) {
    sendError(response, 400, "文本内容不能为空。");
    return;
  }

  const maximumAttempts = 3;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const parsed = await requestQuestionsFromZhipu(text, mode);

      const rawQuestions = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.questions)
          ? parsed.questions
          : [];

      const questions = rawQuestions
        .map((question) => normalizeQuestion(question, mode))
        .filter(Boolean);

      if (questions.length === 0) {
        throw new Error("模型没有返回有效题目。");
      }

      response.json({
        success: true,
        mode,
        count: questions.length,
        questions,
      });

      return;
    } catch (error) {
      console.error(
        `[QUESTION ERROR] attempt=${attempt}`,
        error instanceof Error ? error.message : error,
      );

      if (attempt === maximumAttempts) {
        sendError(
          response,
          502,
          "生成题目失败，请检查后端日志。",
          error instanceof Error ? error.message : String(error),
        );

        return;
      }
    }
  }
});

app.use((request, response, next) => {
  if (
    request.method !== "GET" ||
    request.path === "/api" ||
    request.path.startsWith("/api/")
  ) {
    next();
    return;
  }

  response.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _request, response, _next) => {
  console.error("[SERVER ERROR]", error);

  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "图片不能超过 10MB。"
        : `图片上传失败：${error.message}`;

    sendError(response, 400, message);
    return;
  }

  if (error instanceof SyntaxError && "body" in error) {
    sendError(response, 400, "请求中的 JSON 格式不正确。");
    return;
  }

  sendError(
    response,
    500,
    error instanceof Error ? error.message : "服务器内部错误。",
  );
});

app.listen(port, () => {
  console.log(`知练已启动：http://localhost:${port}`);
});