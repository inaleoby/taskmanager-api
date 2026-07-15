const pool = require('./db');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function migrate() {
  const maxRetries = 5;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id SERIAL PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          description TEXT,
          status VARCHAR(50) DEFAULT 'todo',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('Table "tasks" créée avec succès');
      await pool.end();
      return;
    } catch (err) {
      attempt++;
      console.error(`Tentative ${attempt}/${maxRetries} échouée:`, err.message);
      if (attempt >= maxRetries) {
        console.error('Migration abandonnée après plusieurs tentatives');
        await pool.end();
        process.exit(1);
      }
      await wait(3000);
    }
  }
}

migrate();