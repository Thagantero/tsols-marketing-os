select cron.schedule('tsols-agent-dispatch','*/2 * * * *',$job$select tsols_private.agent_tick();$job$);
