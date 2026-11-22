create extension if not exists pg_cron;
select cron.schedule('tsols-weekly-report-drafts','0 5 * * 1',$job$select tsols_private.generate_due_client_reports('weekly');$job$);
select cron.schedule('tsols-monthly-report-drafts','0 5 1 * *',$job$select tsols_private.generate_due_client_reports('monthly');$job$);
