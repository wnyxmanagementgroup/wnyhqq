/**
 * ฟังก์ชันหลักในการส่งคำขอไปราชการ (Hybrid Mode)
 * แก้ไข: อัปโหลดไฟล์ไปที่ Google Drive (ผ่าน GAS) แทน Firebase Storage
 */
async function submitRequestWithHybrid(formData) {
    const tempId = Date.now().toString(); // ID ชั่วคราวก่อนได้เลข บค. จาก GAS
    
    try {
        // --- 1. ข้าม Cloud Run สำหรับขั้นตอนนี้ — ให้ GAS สร้าง PDF ใน Step ถัดไป ---
        // (template_memo.docx ยังไม่มีในโปรเจกต์ ถ้าต้องการ Cloud Run pre-generation ให้สร้างไฟล์ template ก่อน)
        let preGeneratedUrl = null;

        // --- 2. ส่งข้อมูลไปที่ GAS เพื่อบันทึกเลขที่ (ID) และลง Google Sheet ---
        // ส่ง preGeneratedUrl (ที่เป็นลิงก์ Drive) ไปด้วย
        const payload = {
            ...formData,
            preGeneratedPdfUrl: preGeneratedUrl, 
            fileUrl: preGeneratedUrl, // ส่งไปสำรอง
            action: 'saveRequestAndGeneratePdf'
        };

        const result = await apiCall('POST', 'saveRequestAndGeneratePdf', payload);
        
        if (result.status === 'success') {
            const finalId = result.data.id;
            const docId = finalId.replace(/[\/\\\:\.]/g, '-');
            
            // ใช้ URL ที่ดีที่สุด (จาก Drive ที่เราอัป หรือจากที่ GAS สร้างให้ใหม่)
            const finalUrl = result.data.pdfUrl || result.data.fileUrl || preGeneratedUrl;

            // --- 3. บันทึกข้อมูลลง Firestore (เพื่อให้หน้าเว็บเห็นปุ่มดาวน์โหลดทันที) ---
            await db.collection('requests').doc(docId).set({
                ...formData,
                id: finalId,
                pdfUrl: finalUrl,
                fileUrl: finalUrl, // บันทึกให้ครบทุก field กันเหนียว
                memoPdfUrl: finalUrl,
                docUrl: result.data.docUrl,
                status: 'กำลังดำเนินการ',
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            return result;
        } else {
            throw new Error(result.message || "GAS บันทึกข้อมูลไม่สำเร็จ");
        }

    } catch (error) {
        console.error("🔥 Submission process failed:", error);
        throw error;
    }
}

/**
 * ปรับปรุงการสร้างคำสั่ง (Command) ให้เป็นแบบ Serial Success
 * แก้ไข: อัปโหลดไฟล์ไปที่ Google Drive (ผ่าน GAS) แทน Firebase Storage
 */
async function generateCommandHybrid(data) {
    const docId = data.id.replace(/[\/\\\:\.]/g, '-');
    
    try {
        // 1. ลอง Cloud Run ก่อน
        let cloudRunUrl = null;
        try {
            let templateName = PDF_ENGINE_CONFIG.TEMPLATES.COMMAND_SOLO;
            if (data.attendees && data.attendees.length > 0) {
                templateName = data.attendees.length <= 15 
                    ? PDF_ENGINE_CONFIG.TEMPLATES.COMMAND_SMALL 
                    : PDF_ENGINE_CONFIG.TEMPLATES.COMMAND_LARGE;
            }

            const finalPdfBlob = await generatePdfFromCloudRun(templateName, data);
            
            const filename = `command_${docId}_${Date.now()}.pdf`;

            const uploadRes = await uploadToFirebaseStorage(finalPdfBlob, filename, 'application/pdf', data.username || 'admin');

            if (uploadRes.status === 'success') {
                cloudRunUrl = uploadRes.url;
            }

        } catch (e) {
            console.warn("Cloud Run Command failed, letting GAS handle it.", e);
        }

        // 2. เรียก GAS: ส่ง cloudRunUrl (Drive Link) ไปด้วย 
        const gasPayload = {
            ...data,
            preGeneratedPdfUrl: cloudRunUrl,
            action: 'generateCommand'
        };

        const gasResult = await apiCall('POST', 'generateCommand', gasPayload);

        // 3. บันทึกผลลัพธ์ลง Firestore หลังทุกอย่างใน GAS เสร็จสิ้น
        const finalUrl = gasResult.data.pdfUrl || cloudRunUrl; // ใช้ค่าจาก GAS (ถ้ามี) หรือค่าที่เราอัปเอง
        
        const updateData = {
            commandStatus: 'เสร็จสิ้น',
            commandBookUrl: finalUrl, 
            commandPdfUrl: finalUrl, // เพิ่ม field นี้ด้วย
            commandDocUrl: gasResult.data.docUrl || '',
            lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
        };

        await db.collection('requests').doc(docId).set(updateData, { merge: true });
        return { status: 'success', data: updateData };

    } catch (error) {
        await db.collection('requests').doc(docId).set({
            commandStatus: 'เกิดข้อผิดพลาด',
            errorLog: error.message
        }, { merge: true });
        throw error;
    }
}

/**
 * ฟังก์ชันสร้าง PDF จาก Template ผ่าน Cloud Run
 * @param {string} templateName - ชื่อไฟล์ Template (เช่น 'template_memo.docx')
 * @param {Object} data - ข้อมูลสำหรับเติมใน Template
 * @returns {Promise<Blob>} - ไฟล์ PDF ที่สร้างเสร็จแล้ว
 */
async function generatePdfFromCloudRun(templateName, data) {
    if (typeof PizZip === 'undefined' || typeof Docxtemplater === 'undefined') {
        throw new Error("PizZip หรือ Docxtemplater ยังไม่โหลดเสร็จ กรุณารอสักครู่แล้วลองใหม่");
    }

    // โหลดไฟล์ Template จากเซิร์ฟเวอร์
    const templateRes = await fetch(templateName);
    if (!templateRes.ok) throw new Error(`ไม่สามารถโหลด Template: ${templateName} (${templateRes.status})`);
    const templateArrayBuffer = await templateRes.arrayBuffer();

    // ใช้ Docxtemplater ในการ Render Template
    const zip = new PizZip(templateArrayBuffer);
    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        nullGetter: () => ""
    });

    // เตรียมข้อมูล (ทำให้ค่า null/undefined กลายเป็น "")
    const renderData = {};
    Object.keys(data).forEach(key => {
        const val = data[key];
        renderData[key] = (val !== null && val !== undefined) ? String(val) : "";
    });

    doc.render(renderData);

    // แก้ไขการตัดคำภาษาไทยใน LibreOffice — กำหนด th-TH ก่อนส่ง Cloud Run
    if (typeof patchDocxThaiLanguage === 'function') patchDocxThaiLanguage(doc.getZip());

    const docxBlob = doc.getZip().generate({
        type: "blob",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });

    const cloudRunBaseUrl = (typeof PDF_ENGINE_CONFIG !== 'undefined')
        ? PDF_ENGINE_CONFIG.BASE_URL
        : "https://wny-pdf-engine-660310608742.asia-southeast1.run.app";
    const timeout = (typeof PDF_ENGINE_CONFIG !== 'undefined') ? PDF_ENGINE_CONFIG.TIMEOUT : 60000;

    // Retry loop (2 ครั้ง) — รองรับ Cloud Run cold start และสัญญาณมือถือไม่เสถียร
    // สำคัญ: สร้าง FormData ใหม่ในแต่ละ attempt เพราะ iOS Safari จะ consume body หลัง abort
    let cloudRunResponse, lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeout);
        const attemptPayload = new FormData();
        attemptPayload.append("files", docxBlob, "document.docx");
        try {
            cloudRunResponse = await fetch(`${cloudRunBaseUrl}/forms/libreoffice/convert`, {
                method: "POST",
                body: attemptPayload,
                signal: controller.signal
            });
            clearTimeout(tid);
            break;
        } catch (err) {
            clearTimeout(tid);
            lastErr = err;
            console.warn(`⚠️ generatePdfFromCloudRun attempt ${attempt + 1} failed:`, err.message);
            if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (!cloudRunResponse) {
        const isAbort = lastErr?.name === 'AbortError' || lastErr?.message === 'Fetch is aborted';
        throw new Error(isAbort
            ? 'ระบบสร้าง PDF ใช้เวลานานเกินกำหนด กรุณาลองใหม่อีกครั้ง'
            : (lastErr?.message || 'Cloud Run ไม่ตอบสนอง'));
    }
    if (!cloudRunResponse.ok) throw new Error(`Cloud Run Error: ${cloudRunResponse.status}`);
    return await cloudRunResponse.blob();
}

// blobToBase64 อยู่ใน utils.js แล้ว