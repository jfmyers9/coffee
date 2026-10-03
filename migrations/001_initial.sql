CREATE TABLE bags (
  id uuid PRIMARY KEY,
  data jsonb NOT NULL,
  photo bytea,
  photo_type text
);
CREATE TABLE app_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  default_bag_id uuid REFERENCES bags(id)
);
INSERT INTO app_settings (singleton) VALUES (true);
CREATE TABLE brews (
  id uuid PRIMARY KEY,
  bag_id uuid REFERENCES bags(id),
  dose numeric NOT NULL CHECK (dose > 0),
  started_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('brewing', 'completed', 'discarded')),
  request jsonb NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX brews_started_at ON brews (started_at DESC, id);
CREATE INDEX brews_bag_id ON brews (bag_id);
