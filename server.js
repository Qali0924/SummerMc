const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const { Rcon } = require('rcon-client');
const path = require('path');
const fs = require('fs'); // Biblioteka do zapisu plików

const app = express();
const db = new sqlite3.Database('./database.db');

const MC_SERVER_IP = "summermc.6mc.pl";

// --- TWOJE DANE DO PŁATNOŚCI ---
const SETTINGS = {
    phone_number: "736-630-465", // <--- WPISZ TU SWÓJ NUMER TELEFONU DO BLIKA
};

const RCON_CONFIG = {
    host: "summermc.6mc.pl",
    port: 25575,
    password: "summermc2026"
};

const ADMIN_CREDENTIALS = {
    username: "admin",
    password: "summermc2026" 
};

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(session({
    secret: 'summermc-sklep-bezpieczny-klucz',
    resave: false,
    saveUninitialized: true
}));

// Inicjalizacja baz danych
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS vouchers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE,
        reward_cmd TEXT,
        used INTEGER DEFAULT 0,
        used_by TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nick TEXT,
        item_name TEXT,
        date DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Funkcja RCON
async function sendMinecraftCommand(command) {
    try {
        const rcon = await Rcon.connect(RCON_CONFIG);
        await rcon.send(command);
        await rcon.end();
        return true;
    } catch (err) {
        console.error("RCON Error:", err);
        return false;
    }
}

app.get('/api/server-status', async (req, res) => {
    try {
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        const response = await fetch(`https://api.mcsrvstat.us/2/${MC_SERVER_IP}`);
        const data = await response.json();
        res.json({ online: data.online, players: data.online ? data.players.online : 0 });
    } catch (error) {
        res.json({ online: false, players: 0 });
    }
});

app.get('/api/purchases/recent', (req, res) => {
    db.all(`SELECT nick FROM purchases ORDER BY id DESC LIMIT 14`, [], (err, rows) => {
        if (err) return res.json([]);
        res.json(rows);
    });
});

// --- API: ZAPISYWANIE PAYSAFECARD DO PLIKU ---
app.post('/api/payment/psc', (req, res) => {
    const { nick, amount, psc_code } = req.body;

    if (!nick || !amount || !psc_code) {
        return res.json({ success: false, message: "Uzupełnij wszystkie pola!" });
    }

    // Prosta walidacja kodu PSC (powinien mieć 16 cyfr, usuwamy spacje i myślniki)
    const cleanCode = psc_code.replace(/[\s-]/g, '');
    if (cleanCode.length !== 16 || isNaN(cleanCode)) {
        return res.json({ success: false, message: "Kod Paysafecard musi składać się z dokładnie 16 cyfr!" });
    }

    // Format linii, którą zapiszemy w pliku paysafecard.txt
    const logLine = `[${new Date().toLocaleString()}] Nick: ${nick} | Kwota: ${amount} PLN | KOD PSC: ${cleanCode}\n`;

    // Zapis do pliku paysafecard.txt (dopisanie na końcu pliku)
    fs.appendFile(path.join(__dirname, 'paysafecard.txt'), logLine, (err) => {
        if (err) {
            console.error("Błąd zapisu kodu PSC:", err);
            return res.json({ success: false, message: "Błąd serwera. Spróbuj ponownie później." });
        }
        
        console.log(`[NOWY KOD PSC] Otrzymano kod od ${nick} na kwotę ${amount} PLN.`);
        res.json({ success: true, message: "Twój kod Paysafecard został przesłany! Administrator zweryfikuje go w ciągu kilku godzin." });
    });
});

// --- API: POBIERANIE USTAWIEŃ PRZELEWU BLIK ---
app.get('/api/payment/blik-details', (req, res) => {
    res.json({ phone: SETTINGS.phone_number });
});

// --- UKRYTA TRASA DO PANELU ADMINA ---
app.get('/tajny-panel-admina', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- API: LOGOWANIE ADMINA ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
        req.session.isAdmin = true;
        res.json({ success: true });
    } else {
        res.json({ success: false, message: "Błędne hasło lub login!" });
    }
});

app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

function checkAdmin(req, res, next) {
    if (req.session.isAdmin) { next(); } else { res.status(401).send("Brak dostępu."); }
}

app.post('/api/vouchers/create', checkAdmin, (req, res) => {
    const { code, reward_cmd } = req.body;
    db.run(`INSERT INTO vouchers (code, reward_cmd) VALUES (?, ?)`, [code, reward_cmd], (err) => {
        if (err) return res.json({ success: false, message: "Kod już istnieje!" });
        res.json({ success: true, message: "Voucher gotowy!" });
    });
});

app.get('/api/vouchers/list', checkAdmin, (req, res) => {
    db.all(`SELECT * FROM vouchers`, [], (err, rows) => { res.json(rows); });
});

app.post('/api/vouchers/redeem', (req, res) => {
    const { nick, code } = req.body;
    if (!nick || !code) return res.json({ success: false, message: "Wypełnij dane!" });

    db.get(`SELECT * FROM vouchers WHERE code = ? AND used = 0`, [code], async (err, row) => {
        if (err || !row) return res.json({ success: false, message: "Nieprawidłowy kod!" });

        const finalCommand = row.reward_cmd.replace("{nick}", nick);
        const mcSuccess = await sendMinecraftCommand(finalCommand);

        if (mcSuccess) {
            db.run(`UPDATE vouchers SET used = 1, used_by = ? WHERE id = ?`, [nick, row.id]);
            db.run(`INSERT INTO purchases (nick, item_name) VALUES (?, ?)`, [nick, "Voucher"]);
            res.json({ success: true, message: `Sukces! Nagroda z vouchera przyznana dla gracza ${nick}!` });
        } else {
            res.json({ success: false, message: "Serwer gry jest offline. Spróbuj za chwilę." });
        }
    });
});

app.listen(3000, () => {
    console.log('Serwer SummerMC działa pod adresem: http://localhost:3000');
});