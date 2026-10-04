-- Keep only the ID so delayed/offline creates cannot resurrect deleted brews.
CREATE TABLE deleted_brews (
  id uuid PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
