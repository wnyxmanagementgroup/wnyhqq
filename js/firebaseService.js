/**
 * ฟังก์ชันหลักในการส่งคำขอไปราชการ (Hybrid Mode)
 * แก้ไข: อัปโหลดไฟล์ไปที่ Google Drive (ผ่าน GAS) แทน Firebase Storage
 */
async function submitRequestWithHybrid(formData) {
    const tempId = Date.now().toString(); // ID ชั่วคราวก่อนได้เลข บค. จาก GAS
    
    try {
        // --- 1. พยายามสร้าง PDF ผ่าน Cloud Run ก่อน ---
        let preGeneratedUrl = null;
        try {
            console.log("🚀 Attempting Cloud Run PDF Generation...");
            // สมมติใช้ template_memo.docx สำหรับบันทึกข้อความ
            const pdfBlob = await generatePdfFromCloudRun('template_memo.docx', formData);
            
            // [แก้ไข] เปลี่ยนจาก uploadToStorage (Firebase) เป็น uploadGeneratedFile (GAS/Drive)
            console.log("📤 Uploading to Google Drive via GAS...");
            
            // แปลง Blob เป็น Base64 เพื่อส่งผ่าน API
            const base64Data = await blobToBase64(pdfBlob);
            const fileName = `memo_pending_${tempId}.pdf`;

            // เรียก GAS ให้บันทึกไฟล์ลง Drive
            const uploadRes = await apiCall('POST', 'uploadGeneratedFile', {
                data: base64Data,
                filename: fileName,
                mimeType: 'application/pdf',
                username: formData.username || 'system',
                folderType: 'temp' // (Optional) ถ้าฝั่ง GAS รองรับการแยกโฟลเดอร์
            });

            if (uploadRes.status === 'success') {
                preGeneratedUrl = uploadRes.url;
                console.log("✅ Drive Upload Success! File URL:", preGeneratedUrl);
            } else {
                throw new Error("GAS Upload Failed: " + uploadRes.message);
            }

        } catch (e) {
            console.warn("⚠️ Cloud Run/Upload Failed, will fallback to GAS generation:", e.message);
            // ถ้าตรงนี้พัง preGeneratedUrl จะเป็น null ซึ่งจะไปเปิด Trigger ให้ GAS สร้างเองใน Step ถัดไป
        }

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
            
            // [แก้ไข] เปลี่ยนจาก uploadToStorage เป็น uploadGeneratedFile (Drive)
            const filename = `command_${docId}_${Date.now()}.pdf`;
            const base64Data = await blobToBase64(finalPdfBlob);
            
            const uploadRes = await apiCall('POST', 'uploadGeneratedFile', {
                data: base64Data,
                filename: filename,
                mimeType: 'application/pdf',
                username: data.username || 'admin'
            });

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

    const docxBlob = doc.getZip().generate({
        type: "blob",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });

    // ส่งไปที่ Cloud Run เพื่อแปลงเป็น PDF
    const formPayload = new FormData();
    formPayload.append("files", docxBlob, "document.docx");

    const cloudRunBaseUrl = (typeof PDF_ENGINE_CONFIG !== 'undefined')
        ? PDF_ENGINE_CONFIG.BASE_URL
        : "https://wny-pdf-engine-660310608742.asia-southeast1.run.app";

    const response = await fetch(`${cloudRunBaseUrl}/forms/libreoffice/convert`, {
        method: "POST",
        body: formPayload
    });

    if (!response.ok) throw new Error(`Cloud Run Error: ${response.status}`);
    return await response.blob();
}

// Helper Function: แปลง Blob เป็น Base64 (เผื่อในไฟล์นี้ยังไม่มี)
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