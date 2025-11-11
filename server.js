// server.js 파일 내용 (Vercel 배포용 최종 안정화 버전)

require('dotenv').config(); 

// 🚨 디버깅 코드 추가 (Vercel 로그에서 환경 변수 로드 확인용)
console.log("DEBUG: LAW_QUIZ_GEMINI_KEY is: ", process.env.LAW_QUIZ_GEMINI_KEY ? "Loaded" : "FAIL");
console.log("DEBUG: LAW_QUIZ_OC_ID is: ", process.env.LAW_QUIZ_OC_ID ? "Loaded" : "FAIL");
// --------------------

const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs/promises'); 

const QUIZ_CACHE_FILE = path.join(__dirname, 'cached_law_quizzes.json');

// CORS 설정
app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); 
    next();
});

// 퀴즈 데이터 제공 API 엔드포인트
// 🎯 Vercel에서 /api/quizzes 요청 시, 배포 시 생성된 캐시 파일을 읽어 반환합니다.
app.get('/api/quizzes', async (req, res) => {
    try {
        const data = await fs.readFile(QUIZ_CACHE_FILE, 'utf-8');
        const cachedData = JSON.parse(data);
        res.json(cachedData);
    } catch (error) {
        console.error("🚨 Vercel API 오류: 캐시 파일 읽기 실패:", error.message);
        res.status(500).send("퀴즈 데이터를 불러올 수 없습니다. 서버 구성을 확인해 주세요.");
    }
});


module.exports = app;