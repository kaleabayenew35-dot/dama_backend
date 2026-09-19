require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

p.query(
  "UPDATE pending_owner_callbacks SET status='pending', attempts=0, last_error=NULL WHERE status IN ('failed','pending') AND action IN ('deduct','credit','refund','loss')"
).then(r => {
  console.log('Reset rows:', r.rowCount);
  p.end();
}).catch(e => { console.error(e.message); p.end(); });
