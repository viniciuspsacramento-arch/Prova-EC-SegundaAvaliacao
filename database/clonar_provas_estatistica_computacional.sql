-- =============================================================================
-- Clonar provas da disciplina anterior (filtro "Segunda Prova") para o novo
-- conjunto "Estatística Computacional - Segunda Avaliação", REUTILIZANDO as
-- mesmas questões (provas_questoes aponta para os mesmos questao_id).
--
-- Pré-requisito: MySQL 8+ (ROW_NUMBER).
-- Rode UMA vez. Antes, confira no banco:
--   SELECT id, titulo FROM provas WHERE titulo LIKE '%Segunda Prova%' ORDER BY titulo;
--   -- Esperado: 5 linhas; o trecho "Segunda Prova" deve existir no título para o REPLACE abaixo funcionar.
--
-- Mesmo MySQL da prova antiga: se a tabela tentativas tiver UNIQUE só em matricula,
-- um aluno não poderá fazer as duas provas no mesmo banco. Nesse caso prefira um
-- MySQL novo no Railway só para Estatística Computacional.
-- =============================================================================

INSERT INTO provas (titulo, titulo_publico, tempo_limite)
SELECT
  REPLACE(p.titulo, 'Segunda Prova', 'Estatística Computacional - Segunda Avaliação'),
  'Estatística Computacional — Segunda Avaliação',
  p.tempo_limite
FROM provas p
WHERE p.titulo LIKE '%Segunda Prova%'
  AND p.titulo NOT LIKE '%Estatística Computacional - Segunda Avaliação%'
ORDER BY p.titulo;

INSERT INTO provas_questoes (prova_id, questao_id, ordem, valor_questao)
SELECT n.id, pq.questao_id, pq.ordem, pq.valor_questao
FROM provas_questoes pq
JOIN (
  SELECT id, ROW_NUMBER() OVER (ORDER BY titulo) AS rn
  FROM provas
  WHERE titulo LIKE '%Segunda Prova%'
    AND titulo NOT LIKE '%Estatística Computacional - Segunda Avaliação%'
) antiga ON antiga.id = pq.prova_id
JOIN (
  SELECT id, ROW_NUMBER() OVER (ORDER BY titulo) AS rn
  FROM provas
  WHERE titulo LIKE '%Estatística Computacional - Segunda Avaliação%'
) nova ON nova.rn = antiga.rn;

-- Conferência rápida (5 provas e 8 questões cada, se era o caso na origem):
-- SELECT p.titulo, COUNT(*) AS q FROM provas p
-- JOIN provas_questoes pq ON pq.prova_id = p.id
-- WHERE p.titulo LIKE '%Estatística Computacional - Segunda Avaliação%'
-- GROUP BY p.id, p.titulo;
