-- Other ways to be paid besides InstaPay (Telda, a wallet number, cash, anything else).
-- Optional: existing bills keep working untouched.

-- A JSON list such as [{"kind":"telda","value":"@mazen"},{"kind":"cash"}]. Checked by the API before it is stored.
ALTER TABLE bills ADD COLUMN payee_extra TEXT;
