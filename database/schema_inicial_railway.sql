-- Schema mínimo para a app Prova-EC (MySQL 8+). Execute no banco do Railway (geralmente o nome é `railway`).
-- Depois importe os dados (dump do banco antigo OU scripts de questões + clonar_provas_estatistica_computacional.sql).

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS topicos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    descricao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS questoes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    enunciado TEXT,
    enunciado_imagem VARCHAR(255),
    topico_id INT NOT NULL,
    dificuldade ENUM('facil', 'medio', 'dificil') NOT NULL DEFAULT 'medio',
    tipo ENUM('multipla_escolha', 'verdadeiro_falso', 'dissertativa') NOT NULL DEFAULT 'multipla_escolha',
    usa_imagem BOOLEAN DEFAULT FALSE,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (topico_id) REFERENCES topicos(id) ON DELETE RESTRICT,
    INDEX idx_topico (topico_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS alternativas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    questao_id INT NOT NULL,
    texto TEXT,
    imagem VARCHAR(255),
    correta BOOLEAN DEFAULT FALSE,
    ordem INT NOT NULL,
    FOREIGN KEY (questao_id) REFERENCES questoes(id) ON DELETE CASCADE,
    INDEX idx_questao (questao_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    titulo VARCHAR(200) NOT NULL,
    titulo_publico VARCHAR(200),
    descricao TEXT,
    tempo_limite INT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_titulo (titulo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS provas_questoes (
    prova_id INT NOT NULL,
    questao_id INT NOT NULL,
    ordem INT NOT NULL,
    valor_questao DECIMAL(5,2) DEFAULT 1.0,
    PRIMARY KEY (prova_id, questao_id),
    FOREIGN KEY (prova_id) REFERENCES provas(id) ON DELETE CASCADE,
    FOREIGN KEY (questao_id) REFERENCES questoes(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tentativas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    prova_id INT NOT NULL,
    nome_aluno VARCHAR(100) NOT NULL,
    matricula VARCHAR(32) NOT NULL,
    email VARCHAR(255) NULL,
    iniciado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finalizado_em TIMESTAMP NULL,
    pontuacao DECIMAL(5,2) NULL,
    trocas_aba INT DEFAULT 0,
    tempo_total INT NULL,
    ip_origem VARCHAR(45),
    user_agent TEXT,
    geo_ip_pais VARCHAR(80) NULL,
    geo_ip_estado VARCHAR(80) NULL,
    geo_ip_cidade VARCHAR(120) NULL,
    geo_ip_lat DECIMAL(10,7) NULL,
    geo_ip_lon DECIMAL(10,7) NULL,
    geo_ip_ceara TINYINT(1) NULL,
    geo_gps_lat DECIMAL(10,7) NULL,
    geo_gps_lon DECIMAL(10,7) NULL,
    geo_gps_precisao_m SMALLINT NULL,
    geo_gps_dentro_campus TINYINT(1) NULL,
    FOREIGN KEY (prova_id) REFERENCES provas(id) ON DELETE CASCADE,
    UNIQUE KEY uk_matricula (matricula),
    INDEX idx_prova (prova_id),
    INDEX idx_iniciado (iniciado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS respostas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tentativa_id INT NOT NULL,
    questao_id INT NOT NULL,
    alternativa_id INT NULL,
    resposta_texto TEXT NULL,
    correta BOOLEAN NULL,
    respondido_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tentativa_id) REFERENCES tentativas(id) ON DELETE CASCADE,
    FOREIGN KEY (questao_id) REFERENCES questoes(id) ON DELETE RESTRICT,
    FOREIGN KEY (alternativa_id) REFERENCES alternativas(id) ON DELETE RESTRICT,
    INDEX idx_tentativa (tentativa_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- Um tópico placeholder para poder inserir questões depois
INSERT INTO topicos (id, nome, descricao) VALUES (1, 'Geral', 'Placeholder')
  ON DUPLICATE KEY UPDATE nome = VALUES(nome);
