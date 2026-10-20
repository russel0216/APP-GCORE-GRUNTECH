import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { RecordHeader } from '../../../components/RecordHeader';
import { ErrorBox, Loading, formatSpan, useToast } from '../../../components/ui';
import { CategoryChip, CourseModal, EnrolButton, SeatsLeft, type CourseDetail, type NextSession } from './Courses';

/**
 * A course's own page (2026-10-20, rule 20: every record has a page at
 * `/:id`): what it is, who teaches it, the syllabus outline, every upcoming
 * session with Enroll on each, and who must hold it. Modify opens the one
 * course form; "Enroll now" in the header joins the next open session.
 */
export function CoursePage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [busySession, setBusySession] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<CourseDetail>(`/courses/${id}`)
      .then((c) => {
        setCourse(c);
        setError(null);
      })
      .catch(setError);
  }, [id]);

  useEffect(load, [load]);
  useEffect(() => {
    api
      .get<{ categories: string[] }>('/academy-settings')
      .then((s) => setCategories(s.categories))
      .catch(() => {});
  }, []);

  async function enrolOn(s: NextSession) {
    if (!course) return;
    setBusySession(s.id);
    try {
      setCourse(await api.post<CourseDetail>(`/courses/${course.id}/enrol-me`, { sessionId: s.id }));
      toast('ok', `You are enrolled on ${s.number}`);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not enrol');
    } finally {
      setBusySession(null);
    }
  }

  if (error) return <ErrorBox error={error} />;
  if (!course) return <Loading />;

  const instructor = [course.instructor, course.instructorCredential].filter(Boolean).join(' — ');

  return (
    <div>
      <RecordHeader
        type="Course"
        code={course.code}
        status={course.isActive ? 'ACTIVE' : 'INACTIVE'}
        statusLabel={course.isActive ? 'Active' : 'Inactive'}
        title={course.title}
        meta={
          <>
            <CategoryChip name={course.category} color={course.categoryColor} /> · {course.duration}
            {course.validityMonths ? ` · valid ${course.validityMonths} months` : ' · never expires'}
            {course.requiresAssessment ? ' · assessed' : ''}
            {course.certificateIncluded ? ' · certificate included' : ''}
          </>
        }
        actions={<EnrolButton course={{ ...course, nextSession: course.upcoming[0] ?? null }} onEnrolled={load} />}
        print={`/api/courses/${course.id}/pdf`}
        modify={course.canEdit ? () => setEditing(true) : undefined}
      />

      <div className="stack">
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">About this course</h3>
          </div>
          {course.description ? <p className="academy-prose academy-flush">{course.description}</p> : <p className="faint">No description yet.</p>}
          <dl className="kv">
            <dt>Instructor</dt>
            <dd>{instructor || <span className="faint">Not named — each session names its trainer</span>}</dd>
            <dt>Duration</dt>
            <dd>{course.duration}</dd>
            <dt>Certificate</dt>
            <dd>{course.certificateIncluded ? 'Included on completion' : 'None'}</dd>
            <dt>Passport</dt>
            <dd>A verified completion is credited to the training passport{course.validityMonths ? ` for ${course.validityMonths} months` : ''}.</dd>
            <dt>Required of</dt>
            <dd>{course.requirements.length ? course.requirements.map((r) => r.label).join('; ') : 'Nobody — optional'}</dd>
          </dl>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Syllabus outline</h3>
          </div>
          {course.modules.length === 0 ? (
            <p className="faint">No modules outlined yet{course.canEdit ? ' — Modify › Syllabus.' : '.'}</p>
          ) : (
            <ol className="academy-syllabus">
              {course.modules.map((m) => (
                <li key={m.id ?? m.sequence}>
                  <div className="academy-syllabus-title">
                    Module {m.sequence}: {m.title}
                  </div>
                  {m.topics.length > 0 && (
                    <ul>
                      {m.topics.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Upcoming sessions</h3>
            {can('ghr.training_sessions.create') && (
              <Link className="btn btn-sm" to={`/g-hr/academy/sessions?new=1&courseId=${course.id}`}>
                + New session
              </Link>
            )}
          </div>
          {course.upcoming.length === 0 ? (
            <p className="faint">No session is scheduled — ask HR or the trainer to schedule one.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>When</th>
                    <th>Trainer</th>
                    <th>Where</th>
                    <th>Seats</th>
                    <th aria-label="Enrol" />
                  </tr>
                </thead>
                <tbody>
                  {course.upcoming.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link to={`/g-hr/academy/sessions/${s.id}`} className="mono">
                          {s.number}
                        </Link>
                      </td>
                      <td>{formatSpan(s.startsAt, s.endsAt)}</td>
                      <td>
                        {s.trainer.name}
                        {s.trainer.position && <div className="faint">{s.trainer.position}</div>}
                      </td>
                      <td>{s.venue ?? (s.meetLink ? 'Google Meet' : <span className="faint">—</span>)}</td>
                      <td>
                        <SeatsLeft session={s} />
                      </td>
                      <td className="academy-row-actions">
                        {s.enrolledMe ? (
                          <button type="button" className="btn btn-sm" disabled>
                            ✓ Enrolled
                          </button>
                        ) : s.full ? (
                          <button type="button" className="btn btn-sm" disabled>
                            Full
                          </button>
                        ) : s.canEnrol ? (
                          <button type="button" className="btn btn-sm btn-primary" disabled={busySession === s.id} onClick={() => enrolOn(s)}>
                            {busySession === s.id ? 'Enrolling…' : 'Enroll'}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!course.selfEnrolment && <p className="faint">Self-enrolment is switched off — HR or the trainer enrols people.</p>}
        </div>
      </div>

      {editing && (
        <CourseModal
          id={course.id}
          categories={categories}
          onClose={() => setEditing(false)}
          onChanged={load}
        />
      )}
    </div>
  );
}
