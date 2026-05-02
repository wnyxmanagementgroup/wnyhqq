// --- API HELPER FUNCTIONS ---
// --- API HELPER FUNCTIONS (Enhanced Stability) ---

async function apiCall(method, action, payload = {}, retries = 2) {
    let url = SCRIPT_URL;
    const TIMEOUT_MS = 60000; // 60 วินาที (GAS อาจใช้เวลานานในช่วง cold start)

    // ตั้งค่า Headers
    const options = {
        method: method,
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    };

    // จัดการ Parameter
    if (method === 'GET') {
        const params = new URLSearchParams({ action, ...payload, cacheBust: new Date().getTime() });
        url += `?${params}`;
    } else {
        options.body = JSON.stringify({ action, payload });
    }

    // ฟังก์ชันสำหรับรอเวลา (Backoff) ก่อนลองใหม่
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    // ลูปการทำงานเพื่อลองใหม่ (Retry Loop)
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            // เพิ่ม signal เพื่อรองรับ Timeout
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId); // ยกเลิกตัวจับเวลาถ้าโหลดเสร็จทัน

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const result = await response.json();
            if (result.status === 'error') throw new Error(result.message);

            return result; // ถ้าสำเร็จ ส่งค่ากลับทันที

        } catch (error) {
            clearTimeout(timeoutId); // เคลียร์เวลาเมื่อ error

            const isLastAttempt = attempt === retries;
            const isTimeout = error.name === 'AbortError' || error.message === 'Fetch is aborted' || error.message === 'The operation was aborted.';

            console.warn(`⚠️ API Call Failed (Attempt ${attempt + 1}/${retries + 1}):`, error.message);

            if (isLastAttempt) {
                console.error('❌ API Call Given Up:', error);

                // แปลง error เป็นข้อความไทยที่เข้าใจได้ แล้วให้ caller จัดการแสดงผล
                if (isTimeout) {
                    throw new Error('ระบบใช้เวลานานเกินไป (timeout) กรุณาลองใหม่อีกครั้ง');
                } else if (error.message.includes('Failed to fetch')) {
                    throw new Error('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาเช็คการเชื่อมต่ออินเทอร์เน็ต');
                } else {
                    throw error; // ส่ง error เดิมไปให้ caller (message ชัดเจนอยู่แล้ว)
                }
            }

            // ถ้ายังไม่ครบโควตา ให้รอแป๊บหนึ่งแล้วลองใหม่ (1 วินาที)
            await wait(1000);
        }
    }
}

// --- UTILITY FUNCTIONS ---
function showAlert(title, message) {
    document.getElementById('alert-modal-title').textContent = title;
    document.getElementById('alert-modal-message').textContent = message;
    document.getElementById('alert-modal').style.display = 'flex';
}

function showConfirm(title, message) {
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-message').textContent = message;
    document.getElementById('confirm-modal').style.display = 'flex';

    return new Promise((resolve) => {
        const yesButton = document.getElementById('confirm-modal-yes-button');
        const noButton = document.getElementById('confirm-modal-no-button');
        const onYes = () => { cleanup(); resolve(true); };
        const onNo = () => { cleanup(); resolve(false); };
        
        const cleanup = () => {
            document.getElementById('confirm-modal').style.display = 'none';
            yesButton.removeEventListener('click', onYes);
            noButton.removeEventListener('click', onNo);
        };

        yesButton.addEventListener('click', onYes, { once: true });
        noButton.addEventListener('click', onNo, { once: true });
    });
}

function toggleLoader(buttonId, show) {
    const button = document.getElementById(buttonId);
    if (!button) {
        // console.warn(`Button with id '${buttonId}' not found`);
        return;
    }
    
    const loader = button.querySelector('.loader');
    const text = button.querySelector('span');
    
    if (show) {
        if (loader) loader.classList.remove('hidden');
        if (text) text.classList.add('hidden');
        button.disabled = true;
    } else {
        if (loader) loader.classList.add('hidden');
        if (text) text.classList.remove('hidden');
        button.disabled = false;
    }
}

function getCurrentUser() {
    const userJson = sessionStorage.getItem('currentUser');
    return userJson ? JSON.parse(userJson) : null;
}

function fileToObject(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const data = reader.result.toString().split(',')[1];
            resolve({ filename: file.name, mimeType: file.type, data: data });
        };
        reader.onerror = error => reject(error);
        reader.readAsDataURL(file);
    });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
        const base64String = reader.result.split(',')[1]; 
        resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function formatDisplayDate(dateString) {
    if (!dateString) return 'ไม่ระบุ';
    try {
        const date = new Date(dateString);
        const options = { year: 'numeric', month: 'short', day: 'numeric' };
        return date.toLocaleDateString('th-TH', options);
    } catch (e) {
        return 'ไม่ระบุ';
    }
}

function clearRequestsCache() {
    allRequestsCache = [];
    allMemosCache = [];
    userMemosCache = [];
    userRequestsCache = [];
}

async function loadSpecialPositions() {
    return new Promise(resolve => {
        console.log('Special positions loaded:', Object.keys(specialPositionMap).length);
        resolve();
    });
}

function getStatusColor(status) {
    const statusColors = {
        'เสร็จสิ้น': 'text-green-600 font-semibold',
        'Approved': 'text-green-600 font-semibold',
        'กำลังดำเนินการ': 'text-yellow-600',
        'Pending': 'text-yellow-600',
        'Submitted': 'text-blue-600',
        'รอเอกสาร (เบิก)': 'text-orange-600',
        'นำกลับไปแก้ไข': 'text-red-600',
    };
    return statusColors[status] || 'text-gray-600';
}
// --- PDF MERGE UTILITIES ---

/**
 * ฟังก์ชันรวมไฟล์ PDF (Main PDF + Attachments)
 * @param {Blob} mainPdfBlob - ไฟล์ PDF หลักที่ระบบสร้างขึ้น
 * @param {Array} attachmentFiles - รายการไฟล์แนบ (URL string หรือ File object)
 * @returns {Promise<Blob>} - ไฟล์ PDF ที่รวมเสร็จแล้ว
 */
async function mergePDFs(mainPdfBlob, attachmentFiles = []) {
    try {
        const { PDFDocument } = PDFLib;
        const mergedPdf = await PDFDocument.create();
        
        // Helper: โหลดไฟล์ PDF เป็น ArrayBuffer
        const loadPdfBytes = async (source) => {
            if (source instanceof Blob || source instanceof File) {
                return await source.arrayBuffer();
            } else if (typeof source === 'string' && source.startsWith('http')) {
                const res = await fetch(source);
                if (!res.ok) throw new Error(`Cannot fetch PDF: ${source}`);
                return await res.arrayBuffer();
            }
            return null;
        };

        // 1. ใส่ไฟล์หลักก่อน
        const mainBytes = await loadPdfBytes(mainPdfBlob);
        const mainDoc = await PDFDocument.load(mainBytes);
        const copiedPagesMain = await mergedPdf.copyPages(mainDoc, mainDoc.getPageIndices());
        copiedPagesMain.forEach((page) => mergedPdf.addPage(page));

        // 2. วนลูปใส่ไฟล์แนบ
        for (const file of attachmentFiles) {
            try {
                const bytes = await loadPdfBytes(file);
                if (bytes) {
                    const doc = await PDFDocument.load(bytes);
                    const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
                    copiedPages.forEach((page) => mergedPdf.addPage(page));
                }
            } catch (err) {
                console.warn("Skipping invalid attachment:", err);
            }
        }

        // 3. บันทึกและคืนค่าเป็น Blob
        const mergedBytes = await mergedPdf.save();
        return new Blob([mergedBytes], { type: 'application/pdf' });

    } catch (error) {
        console.error("Merge PDF Error:", error);
        // ถ้า error ให้คืนค่าไฟล์หลักเดิมไปแทน (กันระบบพัง)
        return mainPdfBlob;
    }
}

// --- DOCX THAI LANGUAGE PATCH ---

/**
 * แก้ไขปัญหาการตัดคำภาษาไทยใน LibreOffice
 * Patch ไฟล์ DOCX ZIP หลัง Docxtemplater.render() เพื่อกำหนด th-TH เป็นภาษาเริ่มต้น
 * LibreOffice จะใช้ ICU Thai word segmentation แทน English space-based line-breaking
 *
 * @param {PizZip} docZip - ZIP object จาก doc.getZip() ของ Docxtemplater
 */
function patchDocxThaiLanguage(docZip) {
    try {
        const THAI_LANG = '<w:lang w:val="th-TH" w:eastAsia="th-TH" w:bidi="th-TH"/>';

        // 1. Patch ทุกไฟล์ XML ใน word/ — ครอบคลุม document.xml, styles.xml, header*, footer* ฯลฯ
        //    สำคัญ: w:lang ใน document.xml (run-level) override ค่า default ใน styles.xml
        //    ต้องแทนที่ทุกตัวไม่ใช่แค่ styles เท่านั้น
        Object.keys(docZip.files)
            .filter(fname => fname.startsWith('word/') && fname.endsWith('.xml'))
            .forEach(fname => {
                try {
                    let xml = docZip.files[fname].asText();
                    if (!xml.includes('<w:lang')) return; // ข้ามไฟล์ที่ไม่มี lang tag
                    xml = xml.replace(/<w:lang\b[^>]*\/>/g, THAI_LANG);
                    docZip.file(fname, xml);
                } catch (e) {
                    console.warn(`[patchDocxThaiLanguage] skip ${fname}:`, e.message);
                }
            });

        // 2. word/styles.xml — ถ้าไม่มี w:lang เลยในเอกสาร ให้ฝัง Thai lang ใน rPrDefault
        //    (กรณี template ไม่มี lang tag เลย — run จะ fallback มาใช้ค่านี้)
        if (docZip.files['word/styles.xml']) {
            let xml = docZip.files['word/styles.xml'].asText();
            if (!xml.includes('<w:lang') && xml.includes('</w:rPrDefault>')) {
                if (xml.includes('<w:rPrDefault><w:rPr>')) {
                    xml = xml.replace('<w:rPrDefault><w:rPr>', `<w:rPrDefault><w:rPr>${THAI_LANG}`);
                } else if (xml.includes('<w:rPrDefault/>')) {
                    xml = xml.replace('<w:rPrDefault/>', `<w:rPrDefault><w:rPr>${THAI_LANG}</w:rPr></w:rPrDefault>`);
                } else {
                    xml = xml.replace('</w:rPrDefault>', `<w:rPr>${THAI_LANG}</w:rPr></w:rPrDefault>`);
                }
                docZip.file('word/styles.xml', xml);
            }
        }

        // 3. word/settings.xml — theme font language
        if (docZip.files['word/settings.xml']) {
            let xml = docZip.files['word/settings.xml'].asText();
            if (xml.includes('<w:themeFontLang')) {
                xml = xml.replace(/<w:themeFontLang\b[^>]*\/>/g, '<w:themeFontLang w:val="th-TH" w:eastAsia="th-TH"/>');
            } else {
                xml = xml.replace('</w:settings>', '<w:themeFontLang w:val="th-TH" w:eastAsia="th-TH"/></w:settings>');
            }
            docZip.file('word/settings.xml', xml);
        }

    } catch (patchErr) {
        console.warn('[patchDocxThaiLanguage] Could not patch Thai language settings:', patchErr);
    }
}

// --- GOOGLE DRIVE UPLOAD HELPER ---

/**
 * อัปโหลดไฟล์ (Blob/File) ขึ้น Google Drive ผ่าน GAS
 * @param {Blob|File} blob - ไฟล์ที่ต้องการอัปโหลด
 * @param {string} filename - ชื่อไฟล์
 * @param {string} mimeType - ประเภทไฟล์ (เช่น 'application/pdf')
 * @param {string} username - ชื่อผู้ใช้ (ใช้จัดโฟลเดอร์)
 * @returns {Promise<{status: string, url: string}>}
 */
async function uploadFileToDrive(blob, filename, mimeType, username) {
    if (!blob) {
        throw new Error('ไม่พบไฟล์สำหรับอัปโหลด');
    }

    const safeName = (filename || `upload_${Date.now()}`)
        .replace(/[#\[\]*?]/g, '-')
        .replace(/\s+/g, '_');

    const base64Data = await blobToBase64(blob);
    const result = await apiCall('POST', 'uploadGeneratedFile', {
        data: base64Data,
        filename: safeName,
        mimeType: mimeType || blob.type || 'application/octet-stream',
        username: username || 'system'
    });

    const url = result?.url || result?.data?.url || result?.fileUrl || result?.data?.fileUrl;
    if (!url) {
        throw new Error(result?.message || 'อัปโหลดไป Google Drive ไม่สำเร็จ');
    }

    return { status: 'success', url };
}
