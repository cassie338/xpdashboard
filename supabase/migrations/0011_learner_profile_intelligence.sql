-- Learner Profile keeps parent context, raw assessment evidence, AI drafts,
-- parent review, and published summaries in distinct provenance layers.

create table public.learner_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  learner_id uuid not null,
  date_of_birth date,
  educational_level text not null default '' check (length(educational_level) <= 120),
  interests text not null default '' check (length(interests) <= 4000),
  learning_preferences text not null default '' check (length(learning_preferences) <= 4000),
  observed_strengths text not null default '' check (length(observed_strengths) <= 4000),
  observed_challenges text not null default '' check (length(observed_challenges) <= 4000),
  motivators text not null default '' check (length(motivators) <= 4000),
  helpful_approaches text not null default '' check (length(helpful_approaches) <= 4000),
  additional_notes text not null default '' check (length(additional_notes) <= 6000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (learner_id),
  unique (id, learner_id, user_id),
  constraint learner_profiles_learner_owner_fk
    foreign key (learner_id, user_id) references public.learners(id, user_id)
);

create table public.learner_assessments (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  learner_id uuid not null,
  source_file_id uuid not null unique,
  assessment_name text not null check (length(trim(assessment_name)) between 1 and 160),
  provider text not null default '' check (length(provider) <= 160),
  subject text not null default '' check (length(subject) <= 120),
  assessment_date date,
  parent_notes text not null default '' check (length(parent_notes) <= 4000),
  processing_status text not null default 'uploaded'
    check (processing_status in ('uploaded', 'processing', 'ready_for_review', 'approved', 'failed')),
  ai_analysis_status text not null default 'pending'
    check (ai_analysis_status in ('not_configured', 'pending', 'processing', 'ready', 'failed')),
  processing_error text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, learner_id, user_id),
  constraint learner_assessments_source_owner_fk
    foreign key (source_file_id, learner_id, user_id)
    references public.assessment_source_files(id, learner_id, user_id),
  constraint learner_assessments_learner_owner_fk
    foreign key (learner_id, user_id) references public.learners(id, user_id),
  constraint learner_assessments_approval_check check (
    (processing_status = 'approved' and approved_at is not null)
    or (processing_status <> 'approved' and approved_at is null)
  )
);

create table public.assessment_processing_attempts (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null,
  user_id uuid not null,
  learner_id uuid not null,
  provider_name text not null check (length(trim(provider_name)) between 1 and 120),
  model_name text not null check (length(trim(model_name)) between 1 and 160),
  schema_version text not null check (length(trim(schema_version)) between 1 and 80),
  status text not null check (status in ('succeeded', 'failed')),
  validated_response jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  constraint assessment_processing_attempts_assessment_owner_fk
    foreign key (assessment_id, learner_id, user_id)
    references public.learner_assessments(id, learner_id, user_id),
  constraint assessment_processing_attempts_result_check check (
    (status = 'succeeded' and validated_response is not null and error_message is null)
    or (status = 'failed' and validated_response is null and error_message is not null)
  )
);

create table public.assessment_extractions (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null,
  user_id uuid not null,
  learner_id uuid not null,
  version integer not null check (version > 0),
  schema_version text not null check (length(trim(schema_version)) between 1 and 80),
  extracted_assessment_name text,
  extracted_provider text,
  extracted_subject text,
  extracted_assessment_date date,
  domains jsonb not null default '[]'::jsonb check (jsonb_typeof(domains) = 'array'),
  scores jsonb not null default '[]'::jsonb check (jsonb_typeof(scores) = 'array'),
  provider_strengths jsonb not null default '[]'::jsonb check (jsonb_typeof(provider_strengths) = 'array'),
  provider_difficulties jsonb not null default '[]'::jsonb check (jsonb_typeof(provider_difficulties) = 'array'),
  narrative_observations jsonb not null default '[]'::jsonb check (jsonb_typeof(narrative_observations) = 'array'),
  parent_corrections jsonb not null default '{}'::jsonb check (jsonb_typeof(parent_corrections) = 'object'),
  raw_validated_output jsonb not null check (jsonb_typeof(raw_validated_output) = 'object'),
  review_status text not null default 'draft' check (review_status in ('draft', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (assessment_id, version),
  unique (id, assessment_id, learner_id, user_id),
  constraint assessment_extractions_assessment_owner_fk
    foreign key (assessment_id, learner_id, user_id)
    references public.learner_assessments(id, learner_id, user_id),
  constraint assessment_extractions_review_check check (
    (review_status = 'draft' and reviewed_at is null)
    or (review_status in ('approved', 'rejected') and reviewed_at is not null)
  )
);

create table public.assessment_findings (
  id uuid primary key default gen_random_uuid(),
  extraction_id uuid not null,
  assessment_id uuid not null,
  user_id uuid not null,
  learner_id uuid not null,
  skill_name text not null check (length(trim(skill_name)) between 1 and 240),
  domain text not null default '' check (length(domain) <= 240),
  original_provider_result text not null default '' check (length(original_provider_result) <= 3000),
  provider_reported_status text not null default '' check (length(provider_reported_status) <= 240),
  tested_state text not null check (tested_state in ('tested', 'not_tested', 'unclear')),
  ai_interpretation text not null default '' check (length(ai_interpretation) <= 3000),
  supporting_evidence text not null default '' check (length(supporting_evidence) <= 4000),
  proposed_status text not null
    check (proposed_status in ('mastered', 'developing', 'not_yet_demonstrated', 'needs_verification', 'not_assessed')),
  status_basis text not null
    check (status_basis in ('provider_explicit', 'ai_interpretation', 'insufficient_evidence')),
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  parent_correction text check (parent_correction is null or length(parent_correction) <= 3000),
  parent_status_override text
    check (parent_status_override is null or parent_status_override in ('mastered', 'developing', 'not_yet_demonstrated', 'needs_verification', 'not_assessed')),
  parent_approved boolean not null default false,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (id, assessment_id, learner_id, user_id),
  constraint assessment_findings_extraction_owner_fk
    foreign key (extraction_id, assessment_id, learner_id, user_id)
    references public.assessment_extractions(id, assessment_id, learner_id, user_id),
  constraint assessment_findings_not_tested_check check (
    tested_state <> 'not_tested'
    or proposed_status = 'not_assessed'
  ),
  constraint assessment_findings_mastered_check check (
    proposed_status <> 'mastered'
    or (status_basis = 'provider_explicit' and provider_reported_status <> '')
  ),
  constraint assessment_findings_review_check check (
    (parent_approved = false and reviewed_at is null)
    or (parent_approved = true and reviewed_at is not null)
  )
);

create table public.learner_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  learner_id uuid not null,
  observation_date date not null,
  subject text not null default '' check (length(subject) <= 120),
  observation_text text not null check (length(trim(observation_text)) between 1 and 4000),
  related_skill text not null default '' check (length(related_skill) <= 240),
  assessment_id uuid,
  provenance text not null default 'parent_reported' check (provenance = 'parent_reported'),
  created_at timestamptz not null default now(),
  unique (id, learner_id, user_id),
  constraint learner_observations_learner_owner_fk
    foreign key (learner_id, user_id) references public.learners(id, user_id),
  constraint learner_observations_assessment_owner_fk
    foreign key (assessment_id, learner_id, user_id)
    references public.learner_assessments(id, learner_id, user_id)
);

create table public.learner_priorities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  learner_id uuid not null,
  title text not null check (length(trim(title)) between 1 and 240),
  subject text not null default '' check (length(subject) <= 120),
  notes text not null default '' check (length(notes) <= 3000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, learner_id, user_id),
  constraint learner_priorities_learner_owner_fk
    foreign key (learner_id, user_id) references public.learners(id, user_id)
);

create table public.learner_academic_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  learner_id uuid not null,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded', 'failed')),
  learner_overview text not null default '' check (length(learner_overview) <= 5000),
  strengths text not null default '' check (length(strengths) <= 5000),
  developing_skills text not null default '' check (length(developing_skills) <= 5000),
  learning_patterns text not null default '' check (length(learning_patterns) <= 5000),
  areas_to_investigate text not null default '' check (length(areas_to_investigate) <= 5000),
  teaching_recommendations text not null default '' check (length(teaching_recommendations) <= 5000),
  parent_context text not null default '' check (length(parent_context) <= 5000),
  evidence_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence_snapshot) = 'object'),
  provider_name text not null check (length(trim(provider_name)) between 1 and 120),
  model_name text not null check (length(trim(model_name)) between 1 and 160),
  schema_version text not null check (length(trim(schema_version)) between 1 and 80),
  error_message text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  unique (learner_id, version),
  unique (id, learner_id, user_id),
  constraint learner_academic_summaries_learner_owner_fk
    foreign key (learner_id, user_id) references public.learners(id, user_id),
  constraint learner_academic_summaries_lifecycle_check check (
    (status = 'approved' and approved_at is not null and error_message is null)
    or (status = 'draft' and approved_at is null and error_message is null)
    or (status = 'superseded' and approved_at is not null and error_message is null)
    or (status = 'failed' and approved_at is null and error_message is not null)
  )
);

create table public.learner_summary_evidence (
  id uuid primary key default gen_random_uuid(),
  summary_id uuid not null,
  user_id uuid not null,
  learner_id uuid not null,
  assessment_id uuid,
  observation_id uuid,
  prior_summary_id uuid,
  constraint learner_summary_evidence_summary_owner_fk
    foreign key (summary_id, learner_id, user_id)
    references public.learner_academic_summaries(id, learner_id, user_id),
  constraint learner_summary_evidence_assessment_owner_fk
    foreign key (assessment_id, learner_id, user_id)
    references public.learner_assessments(id, learner_id, user_id),
  constraint learner_summary_evidence_observation_owner_fk
    foreign key (observation_id, learner_id, user_id)
    references public.learner_observations(id, learner_id, user_id),
  constraint learner_summary_evidence_prior_summary_owner_fk
    foreign key (prior_summary_id, learner_id, user_id)
    references public.learner_academic_summaries(id, learner_id, user_id),
  constraint learner_summary_evidence_exact_source_check check (
    num_nonnulls(assessment_id, observation_id, prior_summary_id) = 1
  )
);

create unique index learner_summary_evidence_assessment_unique
  on public.learner_summary_evidence(summary_id, assessment_id)
  where assessment_id is not null;
create unique index learner_summary_evidence_observation_unique
  on public.learner_summary_evidence(summary_id, observation_id)
  where observation_id is not null;
create unique index learner_summary_evidence_prior_unique
  on public.learner_summary_evidence(summary_id, prior_summary_id)
  where prior_summary_id is not null;
create unique index learner_summaries_one_approved_idx
  on public.learner_academic_summaries(learner_id) where status = 'approved';

create index learner_assessments_learner_time_idx
  on public.learner_assessments(user_id, learner_id, assessment_date desc);
create index assessment_findings_assessment_idx
  on public.assessment_findings(assessment_id, domain, skill_name);
create index learner_observations_learner_time_idx
  on public.learner_observations(user_id, learner_id, observation_date desc);
create index learner_priorities_learner_active_idx
  on public.learner_priorities(user_id, learner_id, active, created_at desc);
create index learner_summaries_learner_version_idx
  on public.learner_academic_summaries(user_id, learner_id, version desc);

create function public.protect_assessment_workflow_identity()
returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then raise exception 'Assessment history cannot be deleted'; end if;
  if new.id <> old.id or new.user_id <> old.user_id or new.learner_id <> old.learner_id
    or new.source_file_id <> old.source_file_id
    or new.assessment_name <> old.assessment_name or new.provider <> old.provider
    or new.subject <> old.subject or new.assessment_date <> old.assessment_date
    or new.created_at <> old.created_at then
    raise exception 'Assessment source identity cannot be changed';
  end if;
  return new;
end;
$$;

create trigger learner_assessments_protect_identity
before update or delete on public.learner_assessments
for each row execute function public.protect_assessment_workflow_identity();

create function public.reject_record_mutation()
returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  raise exception 'This provenance record is append-only';
end;
$$;

create trigger learner_observations_append_only
before update or delete on public.learner_observations
for each row execute function public.reject_record_mutation();

create trigger assessment_processing_attempts_append_only
before update or delete on public.assessment_processing_attempts
for each row execute function public.reject_record_mutation();

create function public.protect_assessment_extraction_source()
returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then raise exception 'Assessment extractions cannot be deleted'; end if;
  if new.id <> old.id or new.assessment_id <> old.assessment_id
    or new.user_id <> old.user_id or new.learner_id <> old.learner_id
    or new.version <> old.version or new.schema_version <> old.schema_version
    or new.extracted_assessment_name is distinct from old.extracted_assessment_name
    or new.extracted_provider is distinct from old.extracted_provider
    or new.extracted_subject is distinct from old.extracted_subject
    or new.extracted_assessment_date is distinct from old.extracted_assessment_date
    or new.domains <> old.domains or new.scores <> old.scores
    or new.provider_strengths <> old.provider_strengths
    or new.provider_difficulties <> old.provider_difficulties
    or new.narrative_observations <> old.narrative_observations
    or new.raw_validated_output <> old.raw_validated_output
    or new.created_at <> old.created_at then
    raise exception 'Extracted provider data is immutable';
  end if;
  return new;
end;
$$;

create trigger assessment_extractions_protect_source
before update or delete on public.assessment_extractions
for each row execute function public.protect_assessment_extraction_source();

create function public.begin_assessment_processing(
  p_assessment_id uuid,
  p_provider_name text,
  p_model_name text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assessment public.learner_assessments%rowtype;
  v_attempt_id uuid := gen_random_uuid();
begin
  select * into v_assessment
  from public.learner_assessments
  where id = p_assessment_id
  for update;
  if not found then raise exception 'Assessment not found'; end if;
  if v_assessment.processing_status not in ('uploaded', 'failed')
    and not (
      v_assessment.processing_status = 'processing'
      and v_assessment.updated_at < now() - interval '15 minutes'
    ) then
    raise exception 'Assessment cannot be processed from status %', v_assessment.processing_status;
  end if;

  update public.learner_assessments
  set processing_status = 'processing', ai_analysis_status = 'processing',
      processing_error = null, updated_at = now()
  where id = p_assessment_id;
  return v_attempt_id;
end;
$$;

create function public.record_assessment_processing_success(
  p_assessment_id uuid,
  p_attempt_id uuid,
  p_provider_name text,
  p_model_name text,
  p_extraction jsonb,
  p_findings jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assessment public.learner_assessments%rowtype;
  v_extraction_id uuid := gen_random_uuid();
  v_version integer;
  v_finding jsonb;
begin
  select * into v_assessment
  from public.learner_assessments
  where id = p_assessment_id
  for update;
  if not found then raise exception 'Assessment not found'; end if;
  if jsonb_typeof(p_extraction) <> 'object' or jsonb_typeof(p_findings) <> 'array' then
    raise exception 'Invalid validated assessment result';
  end if;
  if not exists (
    select 1 from public.learner_assessments
    where id = p_assessment_id and processing_status = 'processing'
  ) then raise exception 'Assessment is not processing'; end if;

  select coalesce(max(version), 0) + 1 into v_version
  from public.assessment_extractions where assessment_id = p_assessment_id;

  insert into public.assessment_extractions (
    id, assessment_id, user_id, learner_id, version, schema_version,
    extracted_assessment_name, extracted_provider, extracted_subject,
    extracted_assessment_date, domains, scores, provider_strengths,
    provider_difficulties, narrative_observations, raw_validated_output
  ) values (
    v_extraction_id, p_assessment_id, v_assessment.user_id, v_assessment.learner_id,
    v_version, 'learner-profile-assessment-v1',
    nullif(trim(p_extraction->>'assessmentName'), ''),
    nullif(trim(p_extraction->>'provider'), ''),
    nullif(trim(p_extraction->>'subject'), ''),
    nullif(p_extraction->>'assessmentDate', '')::date,
    coalesce(p_extraction->'domains', '[]'::jsonb),
    coalesce(p_extraction->'scores', '[]'::jsonb),
    coalesce(p_extraction->'providerStrengths', '[]'::jsonb),
    coalesce(p_extraction->'providerDifficulties', '[]'::jsonb),
    coalesce(p_extraction->'narrativeObservations', '[]'::jsonb),
    p_extraction
  );

  for v_finding in select value from jsonb_array_elements(p_findings)
  loop
    insert into public.assessment_findings (
      extraction_id, assessment_id, user_id, learner_id, skill_name, domain,
      original_provider_result, provider_reported_status, tested_state,
      ai_interpretation, supporting_evidence, proposed_status, status_basis, confidence
    ) values (
      v_extraction_id, p_assessment_id, v_assessment.user_id, v_assessment.learner_id,
      v_finding->>'skillName', v_finding->>'domainName', v_finding->>'originalResult',
      trim(coalesce(v_finding->>'providerReportedStatus', '')),
      v_finding->>'testedState', v_finding->>'evidenceSummary',
      concat(v_finding->>'sourceLocator', ': ', v_finding->>'evidenceSummary'),
      v_finding->>'proposedStatus',
      case
        when v_finding->>'statusBasis' = 'provider_explicit' then 'provider_explicit'
        when v_finding->>'statusBasis' in ('insufficient_evidence', 'single_item', 'partial_result', 'not_tested') then 'insufficient_evidence'
        else 'ai_interpretation'
      end,
      v_finding->>'confidence'
    );
  end loop;

  insert into public.assessment_processing_attempts (
    id, assessment_id, user_id, learner_id, provider_name, model_name,
    schema_version, status, validated_response
  ) values (
    p_attempt_id, p_assessment_id, v_assessment.user_id, v_assessment.learner_id,
    p_provider_name, p_model_name, 'learner-profile-assessment-v1',
    'succeeded', p_extraction
  );
  update public.learner_assessments
  set processing_status = 'ready_for_review', ai_analysis_status = 'ready',
      processing_error = null, updated_at = now()
  where id = p_assessment_id;
  return v_extraction_id;
end;
$$;

create function public.record_assessment_processing_failure(
  p_assessment_id uuid,
  p_attempt_id uuid,
  p_provider_name text,
  p_model_name text,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.assessment_processing_attempts (
    id, assessment_id, user_id, learner_id, provider_name, model_name,
    schema_version, status, error_message
  )
  select p_attempt_id, id, user_id, learner_id, p_provider_name, p_model_name,
    'learner-profile-assessment-v1', 'failed', left(p_error_message, 2000)
  from public.learner_assessments
  where id = p_assessment_id and processing_status = 'processing';
  if not found then raise exception 'Assessment is not processing'; end if;
  update public.learner_assessments
  set processing_status = 'failed', ai_analysis_status = 'failed',
      processing_error = left(p_error_message, 2000), updated_at = now()
  where id = p_assessment_id;
end;
$$;

create function public.approve_assessment_review(
  p_assessment_id uuid,
  p_extraction_id uuid,
  p_reviews jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_review jsonb;
  v_finding public.assessment_findings%rowtype;
  v_expected_count integer;
begin
  if jsonb_typeof(p_reviews) <> 'array' then raise exception 'Invalid finding reviews'; end if;
  select count(*) into v_expected_count
  from public.assessment_findings
  where assessment_id = p_assessment_id and extraction_id = p_extraction_id;
  if v_expected_count <> jsonb_array_length(p_reviews)
    or v_expected_count <> (select count(distinct value->>'id') from jsonb_array_elements(p_reviews)) then
    raise exception 'Every assessment finding must be reviewed exactly once';
  end if;
  if not exists (
    select 1 from public.learner_assessments assessment
    join public.assessment_extractions extraction on extraction.assessment_id = assessment.id
    where assessment.id = p_assessment_id and assessment.processing_status = 'ready_for_review'
      and extraction.id = p_extraction_id and extraction.review_status = 'draft'
  ) then raise exception 'Assessment is not ready for review'; end if;

  for v_review in select value from jsonb_array_elements(p_reviews)
  loop
    select * into v_finding
    from public.assessment_findings
    where id = (v_review->>'id')::uuid
      and assessment_id = p_assessment_id and extraction_id = p_extraction_id;
    if not found then raise exception 'Assessment finding not found'; end if;
    if v_review->>'statusOverride' = 'mastered'
      and not (v_finding.status_basis = 'provider_explicit' and v_finding.provider_reported_status <> '') then
      raise exception 'Mastered requires an explicit provider-reported result';
    end if;
    update public.assessment_findings
    set parent_correction = nullif(trim(v_review->>'correction'), ''),
        parent_status_override = nullif(v_review->>'statusOverride', ''),
        parent_approved = true,
        reviewed_at = now()
    where id = v_finding.id;
  end loop;

  update public.assessment_extractions
  set parent_corrections = jsonb_build_object('findings', p_reviews),
      review_status = 'approved', reviewed_at = now()
  where id = p_extraction_id;
  update public.learner_assessments
  set processing_status = 'approved', approved_at = now(), updated_at = now()
  where id = p_assessment_id;
end;
$$;

create function public.record_learner_summary_draft(
  p_user_id uuid,
  p_learner_id uuid,
  p_summary jsonb,
  p_evidence_snapshot jsonb,
  p_provider_name text,
  p_model_name text,
  p_assessment_ids uuid[],
  p_observation_ids uuid[],
  p_prior_summary_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_summary_id uuid := gen_random_uuid();
  v_version integer;
  v_id uuid;
begin
  if not exists (select 1 from public.learners where id = p_learner_id and user_id = p_user_id) then
    raise exception 'Learner not found';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_learner_id::text, 0));
  select coalesce(max(version), 0) + 1 into v_version
  from public.learner_academic_summaries where learner_id = p_learner_id;
  insert into public.learner_academic_summaries (
    id, user_id, learner_id, version, learner_overview, strengths,
    developing_skills, learning_patterns, areas_to_investigate,
    teaching_recommendations, parent_context, evidence_snapshot,
    provider_name, model_name, schema_version
  ) values (
    v_summary_id, p_user_id, p_learner_id, v_version,
    p_summary->>'learnerOverview', p_summary->>'strengths',
    p_summary->>'developingSkills', p_summary->>'learningPatterns',
    p_summary->>'areasToInvestigate', p_summary->>'teachingRecommendations',
    p_summary->>'parentContext', p_evidence_snapshot,
    p_provider_name, p_model_name, 'learner-profile-summary-v1'
  );
  foreach v_id in array coalesce(p_assessment_ids, array[]::uuid[])
  loop
    insert into public.learner_summary_evidence (summary_id, user_id, learner_id, assessment_id)
    values (v_summary_id, p_user_id, p_learner_id, v_id);
  end loop;
  foreach v_id in array coalesce(p_observation_ids, array[]::uuid[])
  loop
    insert into public.learner_summary_evidence (summary_id, user_id, learner_id, observation_id)
    values (v_summary_id, p_user_id, p_learner_id, v_id);
  end loop;
  if p_prior_summary_id is not null then
    insert into public.learner_summary_evidence (summary_id, user_id, learner_id, prior_summary_id)
    values (v_summary_id, p_user_id, p_learner_id, p_prior_summary_id);
  end if;
  return v_summary_id;
end;
$$;

create function public.approve_learner_summary(
  p_user_id uuid,
  p_learner_id uuid,
  p_summary_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_learner_id::text, 0));
  update public.learner_academic_summaries
  set status = 'superseded'
  where learner_id = p_learner_id and user_id = p_user_id and status = 'approved';
  update public.learner_academic_summaries
  set status = 'approved', approved_at = now()
  where id = p_summary_id and learner_id = p_learner_id
    and user_id = p_user_id and status = 'draft';
  if not found then raise exception 'Summary draft not found'; end if;
end;
$$;
create trigger learner_summary_evidence_append_only
before update or delete on public.learner_summary_evidence
for each row execute function public.reject_record_mutation();

create function public.protect_assessment_finding_source()
returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then raise exception 'Assessment findings cannot be deleted'; end if;
  if new.id <> old.id or new.extraction_id <> old.extraction_id
    or new.assessment_id <> old.assessment_id or new.user_id <> old.user_id
    or new.learner_id <> old.learner_id or new.skill_name <> old.skill_name
    or new.domain <> old.domain or new.original_provider_result <> old.original_provider_result
    or new.provider_reported_status <> old.provider_reported_status
    or new.tested_state <> old.tested_state or new.ai_interpretation <> old.ai_interpretation
    or new.supporting_evidence <> old.supporting_evidence
    or new.proposed_status <> old.proposed_status or new.status_basis <> old.status_basis
    or new.confidence <> old.confidence or new.created_at <> old.created_at then
    raise exception 'Extracted provider facts and AI interpretation are immutable';
  end if;
  return new;
end;
$$;

create trigger assessment_findings_protect_source
before update or delete on public.assessment_findings
for each row execute function public.protect_assessment_finding_source();

create function public.protect_summary_content()
returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then raise exception 'Summary versions cannot be deleted'; end if;
  if new.id <> old.id or new.user_id <> old.user_id or new.learner_id <> old.learner_id
    or new.version <> old.version or new.learner_overview <> old.learner_overview
    or new.strengths <> old.strengths or new.developing_skills <> old.developing_skills
    or new.learning_patterns <> old.learning_patterns
    or new.areas_to_investigate <> old.areas_to_investigate
    or new.teaching_recommendations <> old.teaching_recommendations
    or new.parent_context <> old.parent_context or new.evidence_snapshot <> old.evidence_snapshot
    or new.provider_name <> old.provider_name or new.model_name <> old.model_name
    or new.schema_version <> old.schema_version or new.error_message is distinct from old.error_message
    or new.created_at <> old.created_at then
    raise exception 'Summary content and provenance are immutable';
  end if;
  return new;
end;
$$;

create trigger learner_summaries_protect_content
before update or delete on public.learner_academic_summaries
for each row execute function public.protect_summary_content();

alter table public.learner_profiles enable row level security;
alter table public.learner_assessments enable row level security;
alter table public.assessment_processing_attempts enable row level security;
alter table public.assessment_extractions enable row level security;
alter table public.assessment_findings enable row level security;
alter table public.learner_observations enable row level security;
alter table public.learner_priorities enable row level security;
alter table public.learner_academic_summaries enable row level security;
alter table public.learner_summary_evidence enable row level security;

revoke all on public.learner_profiles from anon, authenticated;
revoke all on public.learner_assessments from anon, authenticated;
revoke all on public.assessment_processing_attempts from anon, authenticated;
revoke all on public.assessment_extractions from anon, authenticated;
revoke all on public.assessment_findings from anon, authenticated;
revoke all on public.learner_observations from anon, authenticated;
revoke all on public.learner_priorities from anon, authenticated;
revoke all on public.learner_academic_summaries from anon, authenticated;
revoke all on public.learner_summary_evidence from anon, authenticated;

create function public.register_learner_assessment(
  p_parent_token text,
  p_source_id uuid,
  p_assessment_id uuid,
  p_learner_id uuid,
  p_source_label text,
  p_assessment_date date,
  p_original_filename text,
  p_storage_path text,
  p_content_type text,
  p_byte_size bigint,
  p_file_sha256 text,
  p_parent_notes text default '',
  p_provider text default '',
  p_subject text default ''
)
returns table (source_id uuid, assessment_id uuid)
language plpgsql volatile security definer set search_path = public, storage, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  object_metadata jsonb;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if not public.validate_parent_access_session(p_parent_token) then raise exception 'Parent access required'; end if;
  if not exists (select 1 from public.learners where id = p_learner_id and user_id = current_user_id) then
    raise exception 'Learner not found';
  end if;
  if p_assessment_date is not null and p_assessment_date > current_date then raise exception 'Assessment date cannot be in the future'; end if;
  if length(trim(coalesce(p_source_label, ''))) not between 1 and 120 then raise exception 'Assessment source is required'; end if;
  if length(coalesce(p_provider, '')) > 160 then raise exception 'Provider is too long'; end if;
  if length(coalesce(p_subject, '')) > 120 then raise exception 'Subject is too long'; end if;
  if length(coalesce(p_parent_notes, '')) > 4000 then raise exception 'Parent notes are too long'; end if;
  if p_storage_path not like (current_user_id::text || '/' || p_learner_id::text || '/' || p_source_id::text || '/%') then
    raise exception 'Invalid assessment source path';
  end if;
  if p_content_type not in ('application/pdf', 'image/jpeg', 'image/png') then raise exception 'Unsupported assessment source type'; end if;
  if p_byte_size not between 1 and 10485760 then raise exception 'Invalid assessment source size'; end if;
  if p_file_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Invalid assessment source checksum'; end if;
  select metadata into object_metadata from storage.objects
  where bucket_id = 'assessment-sources' and name = p_storage_path;
  if not found then raise exception 'Stored assessment source not found'; end if;
  if coalesce(object_metadata ->> 'mimetype', '') <> p_content_type
    or coalesce((object_metadata ->> 'size')::bigint, 0) <> p_byte_size then
    raise exception 'Stored assessment source metadata does not match';
  end if;

  insert into public.assessment_source_files (
    id, user_id, learner_id, source_label, assessment_date, original_filename,
    storage_path, content_type, byte_size, file_sha256
  ) values (
    p_source_id, current_user_id, p_learner_id, trim(p_source_label), p_assessment_date,
    trim(p_original_filename), p_storage_path, p_content_type, p_byte_size, p_file_sha256
  );
  insert into public.learner_assessments (
    id, user_id, learner_id, source_file_id, assessment_name, provider, subject,
    assessment_date, parent_notes
  ) values (
    p_assessment_id, current_user_id, p_learner_id, p_source_id, trim(p_source_label), trim(p_provider),
    trim(p_subject), p_assessment_date, trim(coalesce(p_parent_notes, ''))
  );
  return query select p_source_id, p_assessment_id;
end;
$$;

create function public.find_learner_assessment_by_checksum(
  p_parent_token text,
  p_learner_id uuid,
  p_file_sha256 text
)
returns table (id uuid)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.validate_parent_access_session(p_parent_token) then raise exception 'Parent access required'; end if;
  if not exists (select 1 from public.learners where id = p_learner_id and user_id = auth.uid()) then
    raise exception 'Learner not found';
  end if;
  return query
  select assessment.id
  from public.learner_assessments assessment
  join public.assessment_source_files source on source.id = assessment.source_file_id
  where assessment.user_id = auth.uid() and assessment.learner_id = p_learner_id
    and source.file_sha256 = p_file_sha256;
end;
$$;

revoke execute on function public.register_assessment_source(text, uuid, uuid, text, date, text, text, text, bigint, text)
  from authenticated;
revoke all on function public.register_learner_assessment(text, uuid, uuid, uuid, text, date, text, text, text, bigint, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.find_learner_assessment_by_checksum(text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.register_learner_assessment(text, uuid, uuid, uuid, text, date, text, text, text, bigint, text, text, text, text)
  to authenticated;
grant execute on function public.find_learner_assessment_by_checksum(text, uuid, text)
  to authenticated;

revoke all on function public.protect_assessment_workflow_identity() from public, anon, authenticated, service_role;
revoke all on function public.reject_record_mutation() from public, anon, authenticated, service_role;
revoke all on function public.protect_assessment_extraction_source() from public, anon, authenticated, service_role;
revoke all on function public.begin_assessment_processing(uuid, text, text) from public, anon, authenticated;
revoke all on function public.record_assessment_processing_success(uuid, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.record_assessment_processing_failure(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.approve_assessment_review(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.record_learner_summary_draft(uuid, uuid, jsonb, jsonb, text, text, uuid[], uuid[], uuid) from public, anon, authenticated;
revoke all on function public.approve_learner_summary(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_assessment_processing_success(uuid, uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.record_assessment_processing_failure(uuid, uuid, text, text, text) to service_role;
grant execute on function public.begin_assessment_processing(uuid, text, text) to service_role;
grant execute on function public.approve_assessment_review(uuid, uuid, jsonb) to service_role;
grant execute on function public.record_learner_summary_draft(uuid, uuid, jsonb, jsonb, text, text, uuid[], uuid[], uuid) to service_role;
grant execute on function public.approve_learner_summary(uuid, uuid, uuid) to service_role;
revoke all on function public.protect_assessment_finding_source() from public, anon, authenticated, service_role;
revoke all on function public.protect_summary_content() from public, anon, authenticated, service_role;
