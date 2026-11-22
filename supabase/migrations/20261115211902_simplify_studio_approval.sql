begin;

grant update (content_origin) on public.content_calendar to authenticated;

create or replace function tsols_private.guard_content_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op='INSERT' then
    if new.content_origin='manual' and (length(btrim(new.caption))>0 or new.media_asset_id is not null) then
      new.status := 'approved';
    end if;
    return new;
  end if;
  if new.content_origin is distinct from old.content_origin then
    if old.content_origin<>'unclassified' or new.content_origin<>'manual' then
      raise exception 'Only older drafts without a recorded origin can be marked as manual.';
    end if;
    if old.status='approved' then
      raise exception 'This revision is already ready.';
    end if;
    if (new.title,new.caption,new.hashtags,new.call_to_action,new.visual_concept,new.suggested_date,new.suggested_time,new.platform,new.format,new.media_asset_id,
      new.status,new.scheduled_at,new.schedule_cancelled_at) is distinct from
      (old.title,old.caption,old.hashtags,old.call_to_action,old.visual_concept,old.suggested_date,old.suggested_time,old.platform,old.format,old.media_asset_id,
      old.status,old.scheduled_at,old.schedule_cancelled_at) then
      raise exception 'Save your edits before marking this draft as manual.';
    end if;
    new.revision := old.revision + 1;
    new.status := case when length(btrim(new.caption))>0 or new.media_asset_id is not null then 'approved' else 'draft' end;
    new.updated_at := clock_timestamp();
    return new;
  end if;
  if (new.title,new.caption,new.hashtags,new.call_to_action,new.visual_concept,new.suggested_date,new.suggested_time,new.platform,new.format,new.media_asset_id)
  is distinct from
     (old.title,old.caption,old.hashtags,old.call_to_action,old.visual_concept,old.suggested_date,old.suggested_time,old.platform,old.format,old.media_asset_id) then
    if new.status is distinct from old.status or new.scheduled_at is distinct from old.scheduled_at
      or new.schedule_cancelled_at is distinct from old.schedule_cancelled_at then
      raise exception 'Save content before changing its approval or schedule.';
    end if;
    new.revision := old.revision + 1;
    new.status := case when new.content_origin='manual' and (length(btrim(new.caption))>0 or new.media_asset_id is not null)
      then 'approved' else 'draft' end;
    new.scheduled_at := null;
    new.schedule_cancelled_at := null;
  elsif new.status is distinct from old.status then
    if new.content_origin='manual' then
      raise exception 'Manual posts become ready when a caption or media is saved.';
    end if;
    if new.scheduled_at is distinct from old.scheduled_at or new.schedule_cancelled_at is distinct from old.schedule_cancelled_at then
      raise exception 'Approve the revision before planning its schedule.';
    end if;
    if not ((old.status = 'draft' and new.status in ('pending_approval','approved'))
      or (old.status = 'pending_approval' and new.status in ('draft','approved'))) then
      raise exception 'This workflow transition is unavailable.';
    end if;
    if new.status <> 'draft' and length(btrim(new.caption)) = 0 then
      raise exception 'Add a caption before approving the draft.';
    end if;
    if new.status = 'approved' and new.media_asset_id is not null and not exists (
      select 1 from public.media_assets a where a.id=new.media_asset_id and a.client_id=new.client_id and a.approved_at is not null
    ) then
      raise exception 'Approve the attached image in Media Library before approving the post.';
    end if;
  elsif (new.scheduled_at,new.schedule_cancelled_at) is distinct from (old.scheduled_at,old.schedule_cancelled_at) then
    if new.status <> 'approved' or not exists (
      select 1 from public.content_approvals a where a.content_id=old.id and a.revision=old.revision
    ) then
      raise exception 'Approve the saved revision before planning its schedule.';
    end if;
    if new.schedule_cancelled_at is not null then
      if old.scheduled_at is null or old.schedule_cancelled_at is not null or new.scheduled_at is distinct from old.scheduled_at then
        raise exception 'Only an active schedule can be cancelled.';
      end if;
      new.schedule_cancelled_at := clock_timestamp();
    elsif new.scheduled_at is null or new.scheduled_at <= clock_timestamp() then
      raise exception 'Select a future date and time.';
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

commit;
