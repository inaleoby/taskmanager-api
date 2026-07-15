const pool = require('./db');
const express = require('express');
const cors = require('cors');



// async function testConnection() {
//   try {
//     const result = await pool.query('SELECT NOW()');
//     console.log(result.rows);
//   } catch (err) {
//     console.error('Erreur de connexion:', err);
//   }
// }

// testConnection();



const app = express();
app.use(express.json());
app.use(cors());
const PORT = process.env.PORT || 3000;

const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Healthchkeck route 


/**
 * @swagger
 * /health:
 *   get:
 *     summary: Vérifie l'état de santé de l'API
 *     responses:
 *       200:
 *         description: L'API et la base de données fonctionnent
 *       503:
 *         description: Problème de connexion à la base de données
 */
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// Get all Tasks route 


/**
 * @swagger
 * /tasks:
 *   get:
 *     summary: Récupère toutes les tâches
 *     responses:
 *       200:
 *         description: Liste des tâches
 */
app.get('/tasks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Insert Task route

/**
 * @swagger
 * /tasks:
 *   post:
 *     summary: Crée une nouvelle tâche
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Tâche créée avec succès
 */

app.post('/tasks', async (req, res) => {
  try {
    const { title, description } = req.body;

    if (!title || title.trim() === '') {
      return res.status(400).json({ error: 'Le titre est obligatoire' });
    }

    const result = await pool.query(
      'INSERT INTO tasks (title, description) VALUES ($1, $2) RETURNING *',
      [title, description]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Retrieve one task by id 
/**
 * @swagger
 * /tasks/{id}:
 *   get:
 *     summary: Récupère une tâche par son id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Tâche trouvée
 *       404:
 *         description: Tâche non trouvée
 */

app.get('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM tasks WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tâche non trouvée' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Update task route 

/**
 * @swagger
 * /tasks/{id}:
 *   put:
 *     summary: Met à jour une tâche existante
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               status:
 *                 type: string
 *     responses:
 *       200:
 *         description: Tâche mise à jour
 *       404:
 *         description: Tâche non trouvée
 */
app.put('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, status } = req.body;

    const result = await pool.query(
      `UPDATE tasks
       SET title = $1, description = $2, status = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [title, description, status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tâche non trouvée' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Delete task route 

/**
 * @swagger
 * /tasks/{id}:
 *   delete:
 *     summary: Supprime une tâche
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Tâche supprimée
 *       404:
 *         description: Tâche non trouvée
 */

app.delete('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM tasks WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tâche non trouvée' });
    }

    res.json({ message: 'Tâche supprimée', task: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});

