-- Local credentials only. The application never connects as postgres or an owner.
CREATE ROLE mc_migrate LOGIN PASSWORD 'local-migrate';
CREATE ROLE mc_app LOGIN PASSWORD 'local-app';
CREATE ROLE mc_test_migrate LOGIN PASSWORD 'local-test-migrate';
CREATE ROLE mc_test_app LOGIN PASSWORD 'local-test-app';
CREATE DATABASE mission_control OWNER mc_migrate;
CREATE DATABASE mission_control_test OWNER mc_test_migrate;
REVOKE ALL ON DATABASE mission_control FROM PUBLIC;
REVOKE ALL ON DATABASE mission_control_test FROM PUBLIC;
GRANT CONNECT ON DATABASE mission_control TO mc_app;
GRANT CONNECT ON DATABASE mission_control_test TO mc_test_app;

\connect mission_control
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO mc_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mc_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mc_app;

\connect mission_control_test
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO mc_test_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mc_test_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mc_test_app;
