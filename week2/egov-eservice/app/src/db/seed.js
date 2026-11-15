'use strict';

const crypto = require('../lib/crypto');

const iso = (s) => `${s.replace(' ', 'T')}:00+07:00`;

function seed(db) {
  const run = (sql, row) => db.prepare(sql).run(row);
  const users = [
    { username: null, name: 'สมชาย ใจดี', role: 'citizen', id: '1101700123456', masked: 'X-XXXX-XXXXX-45-6', mobile: '0812345678', registered: 1 },
    { username: null, name: 'สมหญิง รักไทย', role: 'citizen', id: '3100600987659', masked: 'X-XXXX-XXXXX-65-9', mobile: '0823456789', registered: 1 },
    { username: null, name: 'มานะ ตั้งใจ', role: 'citizen', id: '5500400111221', masked: 'X-XXXX-XXXXX-22-1', mobile: null, registered: 0 },
    { username: null, name: 'ปิติ มีสุข', role: 'citizen', id: '1909900555015', masked: 'X-XXXX-XXXXX-01-5', mobile: '0834567890', registered: 1 },
    { username: 'off.reg1', name: 'เจ้าหน้าที่ทะเบียน 1', role: 'officer', dept: 'registry' },
    { username: 'off.reg2', name: 'เจ้าหน้าที่ทะเบียน 2', role: 'officer', dept: 'registry' },
    { username: 'off.works1', name: 'เจ้าหน้าที่โยธา 1', role: 'officer', dept: 'works' },
    { username: 'head1', name: 'หัวหน้าฝ่าย', role: 'head' },
    { username: 'exec1', name: 'ผู้บริหาร', role: 'executive' },
    { username: 'audit1', name: 'ผู้ตรวจสอบภายใน', role: 'auditor' },
    { username: 'admin1', name: 'ผู้ดูแลระบบ', role: 'admin' },
  ];
  const uid = {};
  users.forEach((u, i) => {
    const id = i + 1; uid[u.username || u.id] = id;
    run(`INSERT INTO users(id,username,password_hash,name,role,dept,id_no_enc,id_no_hash,id_masked,mobile_enc,email,registered,active,created_at,updated_at)
      VALUES (@id,@username,@password_hash,@name,@role,@dept,@id_no_enc,@id_no_hash,@id_masked,@mobile_enc,'',@registered,1,@at,@at)`, {
      id, username: u.username, password_hash: u.username ? crypto.hashPassword('Test@1234') : null,
      name: u.name, role: u.role, dept: u.dept || null,
      id_no_enc: u.id ? crypto.encrypt(u.id) : null, id_no_hash: u.id ? crypto.blindIndex(u.id) : null,
      id_masked: u.masked || null, mobile_enc: u.mobile ? crypto.encrypt(u.mobile) : null,
      registered: u.registered == null ? 1 : u.registered, at: iso('2026-12-01 09:00'),
    });
  });
  const services = [
    ['SV-01', 'ขอหนังสือรับรอง', 20, null, 3],
    ['SV-02', 'ขออนุญาตประกอบกิจการ', 500, null, 10],
    ['SV-03', 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร', 1000, 10, 15],
  ];
  services.forEach(([id, name, fee, per, sla], i) => run('INSERT INTO services(id,name,fee,fee_per_sqm,sla_days,sort,updated_at) VALUES (?,?,?,?,?,?,?)', [id,name,fee,per,sla,i+1,iso('2026-12-01 09:00') ]));
  [
    ['2026-12-07','ชดเชยวันหยุดทดสอบ (สมมติ)'], ['2026-12-10','วันรัฐธรรมนูญทดสอบ (สมมติ)'],
    ['2026-12-31','วันสิ้นปีทดสอบ (สมมติ)'], ['2027-01-01','วันขึ้นปีใหม่ทดสอบ (สมมติ)'],
  ].forEach((x) => run('INSERT INTO holidays(date,name,created_at) VALUES (?,?,?)', [...x, iso('2026-12-01 09:00')]));

  // caseNo, service, applicant id key, status, fee, qty, area, paid, due, owner, dept, step, issuer, approved, closed, cancelled
  const rows = [
    ['COMPLETED','SV-01','3100600987659',20,1,null,'2026-10-14 10:00','2026-10-19 16:30',null,null,null,'off.reg1',null,'2026-10-16 14:00'],
    ['COMPLETED','SV-03','1909900555015',1200,null,120,'2026-11-02 09:00','2026-11-23 16:30',null,null,null,'off.reg1',null,'2026-11-20 11:00'],
    ['COMPLETED','SV-01','1909900555015',40,2,null,'2026-11-02 09:30','2026-11-05 16:30',null,null,null,'off.reg1',null,'2026-11-04 15:00'],
    ['COMPLETED','SV-02','1101700123456',500,null,null,'2026-11-02 14:00','2026-11-16 16:30',null,null,null,'off.reg1',null,'2026-11-13 15:00'],
    ['COMPLETED','SV-01','1101700123456',20,1,null,'2026-11-03 11:00','2026-11-06 16:30',null,null,null,'off.reg1',null,'2026-11-05 10:00'],
    ['COMPLETED','SV-02','1909900555015',500,null,null,'2026-11-03 15:00','2026-11-17 16:30',null,null,null,'off.reg1',null,'2026-11-19 10:00'],
    ['COMPLETED','SV-02','3100600987659',500,null,null,'2026-11-04 10:00','2026-11-18 16:30',null,null,null,'off.reg1',null,'2026-11-18 16:00'],
    ['REJECTED','SV-01','3100600987659',20,1,null,'2026-11-09 10:00','2026-11-12 16:30',null,null,null,'off.reg1',null,'2026-11-11 09:00'],
    ['CANCELLED','SV-01','1101700123456',20,1,null,'2026-11-09 14:30','2026-11-12 16:30',null,null,null,'off.reg1',null,null,'2026-11-09 15:00'],
    ['IN_REVIEW','SV-03','3100600987659',1000,null,80,'2026-11-12 10:00','2026-12-03 16:30',null,'works',2,'off.reg1'],
    ['PENDING_APPROVAL','SV-03','1101700123456',1500,null,150,'2026-11-16 10:00','2026-12-08 16:30',null,null,3,'off.reg1'],
    ['IN_REVIEW','SV-03','1909900555015',1010,null,101,'2026-11-18 10:00','2026-12-11 16:30','off.reg2','registry',1,'off.reg2'],
    ['IN_REVIEW','SV-02','1101700123456',500,null,null,'2026-11-20 10:00','2026-12-04 16:30','off.reg2','registry',null,'off.reg2'],
    ['PENDING_APPROVAL','SV-02','1909900555015',500,null,null,'2026-11-20 11:00','2026-12-04 16:30',null,null,null,'off.reg1'],
    ['IN_REVIEW','SV-02','3100600987659',500,null,null,'2026-11-20 15:00','2026-12-04 16:30','off.reg2','registry',null,'off.reg2'],
    ['IN_REVIEW','SV-02','1909900555015',500,null,null,'2026-11-23 09:00','2026-12-08 16:30','off.reg2','registry',null,'off.reg2'],
    ['NEED_FIX','SV-01','1101700123456',20,1,null,'2026-11-23 10:00','2026-11-27 16:30','off.reg1','registry',null,'off.reg1'],
    ['IN_REVIEW','SV-02','1101700123456',500,null,null,'2026-11-24 10:00','2026-12-09 16:30','off.reg2','registry',null,'off.reg2'],
    ['APPROVED','SV-02','3100600987659',500,null,null,'2026-11-24 14:00','2026-12-09 16:30',null,null,null,'off.reg1','2026-11-30 15:00'],
    ['IN_REVIEW','SV-01','1101700123456',20,1,null,'2026-11-25 10:00','2026-11-30 16:30','off.reg1','registry',null,'off.reg1'],
    ['IN_REVIEW','SV-02','3100600987659',500,null,null,'2026-11-25 12:00','2026-12-11 16:30','off.reg2','registry',null,'off.reg2'],
    ['IN_REVIEW','SV-01','3100600987659',40,2,null,'2026-11-26 10:00','2026-12-01 16:30','off.reg1','registry',null,'off.reg1'],
    ['IN_REVIEW','SV-01','3100600987659',20,1,null,'2026-11-26 10:30','2026-12-03 16:30','off.reg1','registry',null,'off.reg1'],
    ['SUBMITTED','SV-01','1909900555015',20,1,null,'2026-11-27 11:00','2026-12-02 16:30',null,'registry',null,'off.reg1'],
    ['IN_REVIEW','SV-01','3100600987659',60,3,null,'2026-11-30 10:00','2026-12-03 16:30','off.reg2','registry',null,'off.reg2'],
    ['IN_REVIEW','SV-01','1101700123456',100,5,null,'2026-11-30 16:29','2026-12-03 16:30','off.reg2','registry',null,'off.reg2'],
    ['IN_REVIEW','SV-01','1909900555015',20,1,null,'2026-11-30 16:30','2026-12-04 16:30','off.reg2','registry',null,'off.reg2'],
    ['SUBMITTED','SV-01','3100600987659',20,1,null,'2026-12-01 08:10','2026-12-04 16:30',null,'registry',null,'off.reg1'],
    ['SUBMITTED','SV-01','1909900555015',20,1,null,'2026-12-01 08:20','2026-12-04 16:30',null,'registry',null,'off.reg1'],
    ['SUBMITTED','SV-01','1101700123456',20,1,null,'2026-12-01 08:30','2026-12-04 16:30',null,'registry',null,'off.reg1'],
  ];
  const caseIds = [];
  rows.forEach((r, idx) => {
    const [status, service, applicant, fee, qty, area, paid, due, owner, dept, step, issuer, approvedAt, closed, cancelled] = r;
    const n = idx + 1; const no = `EG-2569-${String(n).padStart(6,'0')}`; const receipt = `RC-2569-${String(n).padStart(6,'0')}`;
    const id = n; caseIds.push(id);
    run(`INSERT INTO cases(id,case_no,service_id,applicant_id,status,qty,area_sqm,fee,fee_locked_at,step,dept,owner_id,issuer_id,approver_id,approved_at,paid_at,due_at,return_count,returned_at,fix_deadline,closed_at,cancelled_at,cancel_reason,reject_reason,created_at,updated_at)
      VALUES (@id,@no,@service,@applicant,@status,@qty,@area,@fee,@paid,@step,@dept,@owner,@issuer,@approver,@approved,@paid,@due,@returns,@returned,@fix,@closed,@cancelled,@cancelReason,@reject,@paid,@paid)`, {
      id,no,service,applicant_id:uid[applicant],applicant:uid[applicant],status,qty,area,fee,paid:paid?iso(paid):null,due:iso(due),step,
      dept:dept || null,owner:owner?uid[owner]:null,issuer:uid[issuer || 'off.reg1'],approver:approvedAt?uid.head1:null,approved:approvedAt?iso(approvedAt):null,
      returns:n===17||n===23?2:0,returned:n===17?iso('2026-11-27 14:00'):n===23?iso('2026-11-30 14:00'):null,
      fix:n===17?iso('2026-12-04 14:00'):null,closed:closed?iso(closed):null,cancelled:cancelled?iso(cancelled):null,cancelReason:cancelled?'CITIZEN':null,reject:status==='REJECTED'?'ไม่อนุมัติ':null,
    });
    run('INSERT INTO payments(case_id,amount,status,paid_at,paid_amount,receipt_no,created_at) VALUES (?,?,?,?,?,?,?)', [id,fee,'PAID',iso(paid),fee,receipt,iso(paid)]);
    const ev=(type,at,from,to,text,stepNo=null)=>run('INSERT INTO case_events(case_id,at,type,actor_id,from_status,to_status,step,text,detail) VALUES (?,?,?,?,?,?,?,?,?)',[id,iso(at),type,null,from,to,stepNo,text||type,'']);
    ev('CREATED',paid,status,status,'ยื่นคำขอ'); ev('PAID',paid,'PENDING_PAYMENT',status,'ชำระเงินแล้ว');
    if (owner) ev('CLAIM', paid, 'SUBMITTED','IN_REVIEW','รับเรื่อง',step || null);
    if (status==='NEED_FIX') ev('RETURN','2026-11-27 14:00','IN_REVIEW','NEED_FIX','ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข');
  });
  // Payment/test records and cases that do not yet have a numbered submission.
  run(`INSERT INTO cases(id,draft_id,service_id,applicant_id,status,qty,fee,created_at,updated_at) VALUES (31,'DR-0001','SV-01',1,'DRAFT',2,40,?,?)`,[iso('2026-12-01 08:50'),iso('2026-12-01 08:50')]);
  run(`INSERT INTO cases(id,draft_id,service_id,applicant_id,status,qty,fee,fee_locked_at,created_at,updated_at) VALUES (32,'DR-0002','SV-02',1,'PENDING_PAYMENT',null,500,?,?,?)`,[iso('2026-12-01 08:55'),iso('2026-12-01 08:55'),iso('2026-12-01 08:55')]);
  run(`INSERT INTO payments(ref,case_id,amount,status,qr_created_at,qr_expires_at,created_at) VALUES ('PP-0001',32,500,'PENDING',?,?,?)`,[iso('2026-12-01 08:55'),iso('2026-12-01 09:10'),iso('2026-12-01 08:55')]);
  const pdfHead = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
  const pdfTail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const pdf = Buffer.concat([pdfHead, Buffer.alloc(1024 - pdfHead.length - pdfTail.length, 0x20), pdfTail]);
  const attach = db.prepare('INSERT INTO attachments(file_id,case_id,doc_key,name,mime,size,data,round,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  rows.forEach((r, i) => {
    const service = r[1]; const keys = service==='SV-01'?['id-card']:service==='SV-02'?['id-card','map']:['id-card','plan','deed'];
    keys.forEach((key,j)=>{ const name=key==='id-card'?'id-card.pdf':`${key}.pdf`; attach.run(`SEED-${String(i+1).padStart(3,'0')}-${j+1}`,i+1,key,name,'application/pdf',1024,pdf,0,uid[r[8] || r[11] || 'off.reg1'],iso(r[6])); });
  });
  attach.run('SEED-DRAFT-2-ID',32,'id-card','id-card.pdf','application/pdf',1024,pdf,0,1,iso('2026-12-01 08:55'));
  attach.run('SEED-DRAFT-2-MAP',32,'map','map.pdf','application/pdf',1024,pdf,0,1,iso('2026-12-01 08:55'));
  // Return history: exact timestamps, reasons, paused business-day counts, and deadlines.
  const ret = db.prepare('INSERT INTO case_returns(case_id,seq,returned_at,returned_by,reason,fix_deadline,resubmitted_at,paused_days) VALUES (?,?,?,?,?,?,?,?)');
  [
    [17,1,'2026-11-24 11:00','ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่','2026-11-25 10:00',1],
    [17,2,'2026-11-27 14:00','ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข',null,null],
    [23,1,'2026-11-27 10:00','ภาพเอกสารเบลอ อ่านเลขไม่ได้','2026-11-30 10:00',1],
    [23,2,'2026-11-30 14:00','ข้อมูลในแบบฟอร์มไม่ครบถ้วน','2026-12-01 08:30',1],
  ].forEach(([cid,seq,at,reason,resub,paused])=>ret.run(cid,seq,iso(at),uid['off.reg1'],reason,iso(at.replace(' ', ' ').replace(/\d\d:\d\d$/,'')+'14:00'),resub?iso(resub):null,paused));
  // Correct the fixed 168-hour deadlines for each return explicitly.
  db.prepare("UPDATE case_returns SET fix_deadline=CASE id WHEN 1 THEN ? WHEN 2 THEN ? WHEN 3 THEN ? WHEN 4 THEN ? END").run(
    iso('2026-12-01 11:00'),iso('2026-12-04 14:00'),iso('2026-12-04 10:00'),iso('2026-12-07 14:00'));
  const docNo='DOC-2569-000001', caseNo='EG-2569-000005', applicant='สมชาย ใจดี', serviceId='SV-01', issuedAt=iso('2026-11-05 10:00'), validUntil='2027-02-02', signer='เจ้าหน้าที่ทะเบียน 1';
  const signature=crypto.signFields([docNo,caseNo,applicant,serviceId,issuedAt,validUntil,signer]);
  run('INSERT INTO documents(doc_no,case_id,case_no,verify_code,applicant,service_id,issued_at,valid_until,signer,signer_id,issued_by,signature) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [docNo,5,caseNo,'K7M2Q9XA',applicant,serviceId,issuedAt,validUntil,signer,uid['off.reg1'],uid['off.reg1'],signature]);
  const counter = db.prepare('INSERT INTO counters(name,value) VALUES (?,?)');
  [['case:2569',30],['receipt:2569',30],['doc:2569',1],['draft',2],['payref',1]].forEach((x) => counter.run(...x));
}

module.exports = { seed };
