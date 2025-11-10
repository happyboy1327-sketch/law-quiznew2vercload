// quiz_generator.js 파일 내용 (최종 확정 및 JSON 파싱 수정 완료 버전)

const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const { GoogleGenAI } = require("@google/genai");

// 환경 변수 로드 
const YOUR_OC_USER_ID = process.env.LAW_QUIZ_OC_ID; 
const GEMINI_API_KEY = process.env.LAW_QUIZ_GEMINI_KEY;

if (!GEMINI_API_KEY) {
    console.error("❌ LAW_QUIZ_GEMINI_KEY 환경 변수가 설정되지 않았습니다. 퀴즈 생성이 불가능합니다.");
}
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const MODEL = "gemini-2.5-flash"; 

const QUIZ_COUNT_PER_SET = 5;
const QUIZ_CACHE_FILE = path.join(__dirname, 'cached_law_quizzes.json');

// URL 정의 (안정적인 HTTPS 프로토콜 사용)
const LAW_API_BASE_URL = "https://www.law.go.kr/DRF";
const LAW_ARTICLE_URL = `${LAW_API_BASE_URL}/lawService.do`;


const VALID_LAW_IDS = [
    "001248", "001444", "001638", "001706", "009318", "001692", "001206"
];  


/**
 * 2. 특정 법령 ID의 조문 원문 목록을 가져옵니다. (JSON 파싱 로직 수정됨)
 */

async function fetchLawArticles(lawId) { 
    if (!YOUR_OC_USER_ID) {
        console.error("❌ fetchLawArticles: LAW_QUIZ_OC_ID가 로드되지 않았습니다.");
        return [];
    }
    
    try {
        const params = {
            'OC': YOUR_OC_USER_ID, 
            'type': 'JSON', 
            'target':'eflaw',
            'ID': lawId, // 'ID' 파라미터 사용
            // 'efYd' 파라미터 제거 완료
        };
        
        const response = await axios.get(LAW_ARTICLE_URL, { params });
        const lawData = response.data;
        
        console.log(`DEBUG: 2단계 API Status for ID=${lawId}: ${response.status}`);

        // 🚨 JSON 파싱 로직 수정: 한글 키('법령', '조문', '조문단위') 사용
        const lawInfo = lawData['법령'];

        if (!lawInfo || !lawInfo['조문'] || !lawInfo['조문']['조문단위']) {
            console.log(`DEBUG: ID=${lawId} 조문 데이터 없음 (JSON 파싱 실패) - 응답 전문:`, lawData);
            return [];
        }

        let joData = lawInfo['조문']['조문단위'];
        
        // 조문이 하나일 경우 객체, 여러 개일 경우 배열로 오는 경우를 대비
        const articleList = Array.isArray(joData) ? joData : [joData].filter(j => j);
        
        // 🚨 필드명 수정: 조문번호, 조문내용, 법령명_한글 사용
        return articleList
            .filter(jo => jo['조문내용']) 
            .map(jo => ({
                num: jo['조문번호'],
                content: jo['조문내용'],
                lawName: lawInfo['기본정보']['법령명_한글'] // 기본정보에서 법령 이름 가져오기
            }));

    } catch (error) {
        console.error(`🚨 fetchLawArticles 오류 (ID: ${lawId}): ${error.message}`);
        return [];
    }
}

/**
 * 3. 조문 원문을 바탕으로 Gemini AI를 사용하여 상식 퀴즈 JSON을 생성합니다.
 */
async function generateQuizJson(article) {
    if (!GEMINI_API_KEY) return null;
    
    const systemInstruction = `
        당신은 법률 상식 퀴즈 생성 전문가입니다. 제공된 조문 내용을 바탕으로 일반인이 풀 수 있는 객관식 퀴즈(4지 선다) 1개를 생성하고, 절대 단순 암기나 빈칸 채우기 문제는 만들지 마세요.
        문제는 일반 법률 상식 수준이어야 합니다. 난이도는 너무 어렵지 않고 평이해야 합니다. 응답은 반드시 요청된 JSON 스키마를 따라야 합니다.
    `;

    const prompt = `
        다음 법령의 조문을 참고하여 일반 법률 상식 퀴즈를 생성해 주세요.
        ---
        법령: ${article.lawName}
        조문 번호: ${article.num}
        조문 내용: ${article.content}
        ---
        요구 사항: 'timer_sec'은 15로 설정하고, 'explanation'에는 복습 모드를 위해 법률 상식 해설을 자세히 작성하세요.
    `;

    const quizSchema = {
        type: "object",
        properties: {
            id: { type: "integer" },
            category: { type: "string" },
            question: { type: "string" },
            options: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        text: { type: "string" },
                        is_correct: { type: "boolean" }
                    },
                    required: ["text", "is_correct"]
                }
            },
            answer: { type: "string" },
            explanation: { type: "string" },
            timer_sec: { type: "integer" }
        },
        required: ["id", "category", "question", "options", "answer", "explanation", "timer_sec"]
    };

    try {
        const response = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                systemInstruction: systemInstruction,
                responseMimeType: "application/json", 
                responseSchema: quizSchema,
            },
        });
        
        let quiz = JSON.parse(response.text);
        quiz.source_law_name = article.lawName; 
        return quiz;

    } catch (error) {
        console.error("🚨 3단계 실패: Gemini API 호출 실패! 오류:", error.message);
        return null;
    }
}

/**
 * 4. 전체 프로세스 실행 (세트 내 중복 방지 로직 적용)
 */
async function generateAndCacheQuizzes() {
    console.log(`[시작] 5개 법률 상식 퀴즈 생성 및 캐싱 작업 (${new Date().toISOString()})`);
    const allGeneratedQuizzes = [];
    let generatedCount = 0;
    
    const MAX_RETRIES = 10;
    let retries = 0;

    // 💡 새로운 퀴즈 세트를 위해 원본 ID 목록을 복사하여 사용 (세트 내 중복 방지)
    let availableLawIds = [...VALID_LAW_IDS]; 

    while (generatedCount < QUIZ_COUNT_PER_SET && retries < MAX_RETRIES) {
        retries++;

        // 💡 1. 사용 가능한 ID가 없으면 중단
        if (availableLawIds.length === 0) {
            console.warn("⚠️ 경고: 현재 퀴즈 세트에 사용할 법령 ID가 모두 소진되었습니다.");
            break;
        }

        // 💡 2. availableLawIds에서 랜덤 인덱스를 선택
        const randomIndex = Math.floor(Math.random() * availableLawIds.length);
        
        // 💡 3. 해당 ID를 배열에서 제거하고 lawId 변수에 할당 (splice의 반환값은 배열이므로 [0]으로 값 추출)
        const lawId = availableLawIds.splice(randomIndex, 1)[0]; 
        
        console.log(`DEBUG: 현재 세트에서 법령 ID [${lawId}] 선택. 남은 ID 수: ${availableLawIds.length}`);


        const articles = await fetchLawArticles(lawId); 
        
        if (articles.length === 0) {
            console.warn(`⚠️ 2단계 경고: 법령 ID=${lawId}의 유효한 조문이 없어 다음 법령을 시도합니다. (시도 횟수: ${retries})`);
            // 해당 ID는 이미 제거되었으므로, 이 세트 내에서 다시 시도되지 않음
            continue;
        }

        const randomArticle = articles[Math.floor(Math.random() * articles.length)];
        
        const quiz = await generateQuizJson(randomArticle);

        if (quiz) {
            // NOTE: quiz.id는 고유하게 생성되어야 하므로 Date.now()와 generatedCount 조합 사용 유지
            quiz.id = Date.now() + generatedCount; 
            allGeneratedQuizzes.push(quiz);
            generatedCount++;
            console.log(`-> 퀴즈 #${generatedCount} 생성 완료 (법령: ${quiz.source_law_name})`);
        } else {
            console.error("🚨 3단계 실패: Gemini AI 퀴즈 생성 실패. 키 또는 모델 호출 오류. 작업 중단.");
            break;
        }
    }

    if (allGeneratedQuizzes.length > 0) {
        await fs.writeFile(QUIZ_CACHE_FILE, JSON.stringify(allGeneratedQuizzes, null, 2), 'utf-8');
        console.log(`[성공] 총 ${allGeneratedQuizzes.length}개의 퀴즈가 ${QUIZ_CACHE_FILE}에 캐싱되었습니다.`);
    } else {
        console.error(`[최종 실패] 퀴즈 생성 작업이 중단되었거나 생성된 퀴즈가 0개입니다. (최대 시도 횟수 ${MAX_RETRIES}회 초과) 이전 로그를 확인하세요.`);
    }
}

module.exports = {
    generateAndCacheQuizzes
};